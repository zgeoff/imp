#!/bin/bash
# M3 end to end: drive impd in the dev container with the CLI from this host.
#
#   scripts/e2e-lifecycle.sh
#
# Starts the dev container (scripts/dev.sh up) if needed and leaves it running.
# Env: IMP_E2E_MAX_NEW_MS (default 3000) bounds `imp new`, command to usable.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

max_new_ms=${IMP_E2E_MAX_NEW_MS:-3000}
name=e2e-$$
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

# under the repo: dev.sh mounts it at the same path in the container
build_dir=$IMP_ROOT/.cache/e2e-build-$$

cleanup() {
  local rc=$?
  imp rm "$name" >/dev/null 2>&1 || true
  imp rm "$name-img" >/dev/null 2>&1 || true
  imp image rm "e2e-built" >/dev/null 2>&1 || true
  rm -rf "$build_dir"
  if [ $rc -ne 0 ]; then
    echo "== impd log tail"
    docker logs --tail 30 imp-dev 2>&1 || true
  fi
}
trap cleanup EXIT

step "dev container"
"$IMP_ROOT/scripts/dev.sh" up
IMP_TOKEN=$("$IMP_ROOT/scripts/dev.sh" token)
export IMP_TOKEN

step "info"
imp info
imp info --json | grep -q '"impCount"' || fail "info --json has no impCount"

step "new $name"
t0=$(now_ms)
out=$(imp new "$name")
uname_out=$(imp exec "$name" -- uname -a)
new_ms=$(($(now_ms) - t0))
echo "$out"
echo "$uname_out"
expect_eq "${out%% *}" "$name" "imp new prints the name first"
[[ $out == *"http://$name.imp.localhost:7080"* ]] || fail "imp new prints no URL: $out"
[[ $uname_out == Linux\ $name\ * ]] || fail "uname -a: $uname_out"
echo "imp new + first exec: ${new_ms} ms (limit ${max_new_ms} ms)"
[ "$new_ms" -le "$max_new_ms" ] || fail "imp new took ${new_ms} ms"

step "ls"
slot=$(imp ls --json | NAME=$name bun -e \
  'const imps = await Bun.stdin.json(); console.log(imps.find((i) => i.name === process.env.NAME).slot)')
imp ls | grep -q "^$name  *running" || fail "ls does not show $name running"
imp ls --json | grep -q "\"name\": \"$name\"" || fail "ls --json lacks $name"
expect_eq "$(imp url "$name" | head -1)" "http://$name.imp.localhost:7080" "imp url"

step "exec with stdin"
expect_eq "$(printf 'hello stdin\n' | imp exec "$name" -- cat)" "hello stdin" "stdin round trip"
expect_eq "$(seq 1 20000 | imp exec "$name" -- wc -l)" "20000" "large stdin"

step "exit codes and stderr"
rc=0
err=$(imp exec "$name" -- sh -c 'echo to-stderr >&2; exit 7' 2>&1 >/dev/null) || rc=$?
expect_eq "$rc" 7 "exit code"
expect_eq "$err" "to-stderr" "stderr"
rc=0
imp exec "$name" -- sh -c 'kill -TERM $$' || rc=$?
expect_eq "$rc" 143 "exit code of a signalled process"
rc=0
imp exec "$name" -- /no/such/binary 2>/dev/null || rc=$?
expect_eq "$rc" 127 "exit code of a command that cannot start"

step "exec -t"
tty_out=$(imp exec -t "$name" -- sh -c 'tty; stty size' </dev/null | tr -d '\r')
echo "$tty_out"
[[ $tty_out == /dev/pts/* ]] || fail "exec -t has no pty: $tty_out"

step "console"
console_out=$( (
  printf 'echo console-$((40 + 2))\n'
  sleep 1.5
  printf 'exit 5\n'
) | SHELL=/bin/bash script -qec "${cli[*]} console $name" /dev/null | tr -d '\r' || true)
echo "$console_out" | tail -3
[[ $console_out == *console-42* ]] || fail "console did not run the command"
rc=0
(sleep 1; printf 'exit 5\n') | SHELL=/bin/bash script -qec "${cli[*]} console $name" /dev/null >/dev/null || rc=$?
expect_eq "$rc" 5 "console exit code"

step "stop, start, data persisted"
imp exec "$name" -- sh -c "echo $name-data > /root/persist && sync"
imp stop "$name"
imp ls | grep -q "^$name  *stopped" || fail "ls does not show $name stopped"
rc=0
imp exec "$name" -- true 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] || fail "exec in a stopped imp succeeded"
t0=$(now_ms)
imp start "$name"
expect_eq "$(imp exec "$name" -- cat /root/persist)" "$name-data" "data after stop and start"
echo "start + exec: $(($(now_ms) - t0)) ms"

step "impd restart keeps the VM"
"$IMP_ROOT/scripts/dev.sh" restart
imp ls | grep -q "^$name  *running" || fail "$name not running after an impd restart"
expect_eq "$(imp exec "$name" -- cat /root/persist)" "$name-data" "exec after an impd restart"

step "rm"
imp rm "$name"
if imp ls | grep -q "^$name "; then fail "$name still listed after rm"; fi
if docker exec imp-dev ip link show "imp$slot" >/dev/null 2>&1; then
  fail "tap imp$slot left behind"
fi

step "images: build, boot, rm"
mkdir -p "$build_dir"
printf 'FROM alpine:3.20\nRUN echo built > /etc/e2e-marker\nENV E2E=yes\nWORKDIR /srv\n' >"$build_dir/Dockerfile"
imp image build "$build_dir" --name e2e-built
imp image ls | grep -q '^e2e-built ' || fail "image ls lacks e2e-built"
imp new "$name-img" --image e2e-built >/dev/null
expect_eq "$(imp exec "$name-img" -- sh -c 'cat /etc/e2e-marker; echo "$E2E"; pwd' | tr '\n' ' ')" \
  "built yes /srv " "image content and OCI config"
rc=0
(sleep 1; printf 'exit 4\n') | SHELL=/bin/bash script -qec "${cli[*]} console $name-img" /dev/null >/dev/null || rc=$?
expect_eq "$rc" 4 "console on an image without bash"
imp rm "$name-img"
imp image rm e2e-built
if imp image ls | grep -q '^e2e-built '; then fail "e2e-built still listed after image rm"; fi

echo "== PASS"
