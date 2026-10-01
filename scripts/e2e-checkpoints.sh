#!/bin/bash
# M5 end to end: checkpoint, restore and fork against impd in the dev container.
#
#   scripts/e2e-checkpoints.sh
#
# Starts the dev container (scripts/dev.sh up) if needed and leaves it running.
# Env: IMP_DEV_NAME and IMP_DEV_PORT_OFFSET as for scripts/dev.sh.
#      IMP_E2E_MAX_CHECKPOINT_MS (default 500) bounds a checkpoint of a running
#      imp, as impd measures it.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

container=${IMP_DEV_NAME:-imp-dev}
max_checkpoint_ms=${IMP_E2E_MAX_CHECKPOINT_MS:-500}
export IMP_URL=${IMP_URL:-http://localhost:$((7070 + ${IMP_DEV_PORT_OFFSET:-0}))}
name=cp-e2e-$$
cli=(bun "$IMP_ROOT/packages/cli/src/main.ts")

imp() { "${cli[@]}" "$@"; }

now_ms() { echo $(($(date +%s%N) / 1000000)); }

step() { echo "== $*"; }

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# expect_eq ACTUAL EXPECTED WHAT
expect_eq() {
  [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"
}

# json_field JSON EXPR evaluates EXPR against the parsed JSON (bound to `v`).
json_field() {
  EXPR=$2 bun -e 'const v = JSON.parse(await Bun.stdin.text()); console.log(eval(process.env.EXPR))' <<<"$1"
}

imp_id() { json_field "$(imp ls --json)" "v.find((i) => i.name === '$1').id"; }

# impd_ms PATTERN prints the milliseconds from the newest impd log line that
# matches PATTERN and ends in `in <n>ms`.
impd_ms() {
  docker logs "$container" 2>&1 | grep -E "$1" | tail -1 | sed -E 's/.* in ([0-9]+)ms$/\1/'
}

# in_container CMD... runs CMD in the dev container.
in_container() { docker exec "$container" "$@"; }

cleanup() {
  local rc=$?
  for imp_name in "$name" "$name-old" "$name-live"; do
    imp rm "$imp_name" >/dev/null 2>&1 || true
  done
  if [ $rc -ne 0 ]; then
    echo "== impd log tail"
    docker logs --tail 30 "$container" 2>&1 || true
  fi
}
trap cleanup EXIT

step "dev container"
"$IMP_ROOT/scripts/dev.sh" up
IMP_TOKEN=$("$IMP_ROOT/scripts/dev.sh" token)
export IMP_TOKEN

step "new $name, a=1"
imp new "$name" >/dev/null
id=$(imp_id "$name")
imp exec "$name" -- sh -c 'echo 1 > /root/a'

step "checkpoint v1 (running)"
t0=$(now_ms)
imp checkpoint "$name" v1
checkpoint_cli_ms=$(($(now_ms) - t0))
v1=$(json_field "$(imp checkpoints "$name" --json)" "v.find((c) => c.label === 'v1').id")
checkpoint_ms=$(impd_ms "$name: checkpoint $v1 in")
in_container test -f "/var/lib/imp/imps/$id/checkpoints/$v1/disk.ext4" || fail "no checkpoint disk"

step "a=2, b exists, restore v1"
imp exec "$name" -- sh -c 'echo 2 > /root/a; touch /root/b'
t0=$(now_ms)
imp restore "$name" v1 >/dev/null
restore_cli_ms=$(($(now_ms) - t0))
restore_ms=$(impd_ms "$name: restored $v1 in")
expect_eq "$(imp exec "$name" -- cat /root/a)" 1 "a after restore"
imp exec "$name" -- test ! -e /root/b || fail "b survived the restore"
imp ls | grep -q "^$name  *running" || fail "$name not running after restore"

step "restore a stopped imp leaves it stopped"
imp exec "$name" -- sh -c 'echo 3 > /root/a'
imp stop "$name" >/dev/null
imp restore "$name" "$v1" >/dev/null
imp ls | grep -q "^$name  *stopped" || fail "$name not stopped after restoring it stopped"
imp start "$name" >/dev/null
expect_eq "$(imp exec "$name" -- cat /root/a)" 1 "a after a stopped restore"

step "fork from v1 and from the live disk"
imp exec "$name" -- sh -c 'echo live > /root/l'
imp fork "$name" "$name-old" --from v1 >/dev/null
t0=$(now_ms)
imp fork "$name" "$name-live" >/dev/null
fork_cli_ms=$(($(now_ms) - t0))
expect_eq "$(imp exec "$name-old" -- cat /root/a)" 1 "a in the v1 fork"
imp exec "$name-old" -- test ! -e /root/l || fail "the v1 fork has a later file"
expect_eq "$(imp exec "$name-live" -- cat /root/l)" live "l in the live fork"
expect_eq "$(imp exec "$name-live" -- hostname)" "$name-live" "fork hostname"
[ "$(imp_id "$name-live")" != "$id" ] || fail "the fork shares the source id"
imp ls | grep -q "^$name-live  *running" || fail "the live fork is not running"
expect_eq "$(json_field "$(imp checkpoints "$name-live" --json)" 'v.length')" 0 "fork checkpoints"

step "writes stay on their side"
imp exec "$name" -- sh -c 'echo src > /root/s'
imp exec "$name-live" -- sh -c 'echo fork > /root/f'
imp exec "$name-old" -- sh -c 'echo old > /root/f'
imp exec "$name" -- test ! -e /root/f || fail "a fork write reached the source"
imp exec "$name-live" -- test ! -e /root/s || fail "a source write reached the live fork"
imp exec "$name-old" -- test ! -e /root/s || fail "a source write reached the v1 fork"
expect_eq "$(imp exec "$name-live" -- cat /root/f)" fork "live fork file"
expect_eq "$(imp exec "$name-old" -- cat /root/f)" old "v1 fork file"

step "checkpoint list and delete"
imp checkpoint "$name" >/dev/null
expect_eq "$(json_field "$(imp checkpoints "$name" --json)" 'v.length')" 2 "checkpoint count"
expect_eq "$(json_field "$(imp checkpoints "$name" --json)" 'v[1].label')" v1 "oldest last"
imp checkpoints "$name"
rc=0
imp checkpoint "$name" v1 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "a duplicate label was accepted"
imp checkpoint rm "$name" v1
expect_eq "$(json_field "$(imp checkpoints "$name" --json)" 'v.length')" 1 "count after rm"
in_container test ! -e "/var/lib/imp/imps/$id/checkpoints/$v1" || fail "$v1 dir left behind"
rc=0
imp restore "$name" v1 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "restore of a deleted checkpoint succeeded"

step "rm removes the checkpoints"
imp rm "$name"
in_container test ! -e "/var/lib/imp/imps/$id" || fail "imps/$id left behind"
expect_eq "$(imp exec "$name-old" -- cat /root/a)" 1 "the v1 fork outlives its source"

echo "checkpoint (running): impd ${checkpoint_ms} ms, CLI ${checkpoint_cli_ms} ms (limit ${max_checkpoint_ms} ms)"
echo "restore (running): impd ${restore_ms} ms, CLI ${restore_cli_ms} ms"
echo "fork (live) + boot: CLI ${fork_cli_ms} ms"
[ "$checkpoint_ms" -le "$max_checkpoint_ms" ] || fail "checkpoint took ${checkpoint_ms} ms"

echo "== PASS"
