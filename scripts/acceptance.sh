#!/bin/bash
# imp acceptance test: proves the definition of done, one timed section per
# requirement, against impd in the dev container (scripts/dev.sh).
#
#   scripts/acceptance.sh [--clean] [--only N[,N...]] [--keep] [--reuse]
#
#   --clean   full reset first: tailnet logout, remove imp-dev, wipe the dev
#             data dir (XFS file, db, images, imps, checkpoints, tailscale state)
#   --only    run only these sections (setup always runs)
#   --keep    leave the test's imps and images in place at the end
#   --reuse   keep a running imp-dev instead of `dev.sh down` + `up`
#
# Sections: 1 shell  2 docker  3 byo-image  4 checkpoint-fork  5 sleep-wake
#           6 scale  7 restart  8 tailscale
#
# Env (passed to impd through scripts/dev.sh):
#   ACC_RAM_BUDGET_MIB  (default 6144) becomes IMP_RAM_BUDGET_MIB
#   ACC_IDLE_TIMEOUT_S  (default 10)   becomes IMP_IDLE_TIMEOUT_S
# Env (test only):
#   ACC_SCALE_COUNT (30), ACC_SCALE_MEMORY_MIB (512), ACC_SCALE_FILL_MIB (256)
#   ACC_MAX_NEW_MS (3000)
#
# Writes metrics to scripts/acceptance/results.json. Exits non-zero if any
# section fails.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
# shellcheck source=scripts/acceptance/lib.sh
source "$IMP_ROOT/scripts/acceptance/lib.sh"

export PATH="$IMP_ROOT/scripts:$PATH"

ACC_PREFIX=acc-
ACC_DIR=$IMP_ROOT/scripts/acceptance
ACC_TMP=$(mktemp -d "${TMPDIR:-/tmp}/imp-acceptance.XXXXXX")
RESULTS=$ACC_DIR/results.json
DEV=$IMP_ROOT/scripts/dev.sh
DATA=${IMP_DEV_DATA:-$IMP_ROOT/.data/dev}

budget_mib=${ACC_RAM_BUDGET_MIB:-6144}
idle_s=${ACC_IDLE_TIMEOUT_S:-10}
scale_count=${ACC_SCALE_COUNT:-30}
scale_memory=${ACC_SCALE_MEMORY_MIB:-512}
scale_fill=${ACC_SCALE_FILL_MIB:-256}
max_new_ms=${ACC_MAX_NEW_MS:-3000}

export IMP_RAM_BUDGET_MIB=$budget_mib IMP_IDLE_TIMEOUT_S=$idle_s

SECTION_NAMES=(setup shell docker byo-image checkpoint-fork sleep-wake scale restart tailscale)

clean=0
keep=0
reuse=0
only=""
while [ $# -gt 0 ]; do
  case $1 in
    --clean) clean=1 ;;
    --keep) keep=1 ;;
    --reuse) reuse=1 ;;
    --only)
      only=${2:?--only needs a section number}
      shift
      ;;
    -h | --help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "acceptance: unknown argument $1" >&2
      exit 2
      ;;
  esac
  shift
done

wanted() { [ -z "$only" ] || [[ ",$only," == *",$1,"* ]]; }

cleanup() {
  local rc=$?
  write_results
  if [ $keep = 1 ]; then
    echo "== --keep: imps and images left in place"
  elif curl -fsS --max-time 5 http://localhost:7070/health >/dev/null 2>&1; then
    echo "== cleanup"
    mapfile -t names < <(prefixed_imps 2>/dev/null || true)
    remove_imps "${names[@]}"
    local image
    for image in acc-tiny acc-bare acc-hello; do
      imp image rm "$image" >/dev/null 2>&1 || true
    done
  fi
  rm -rf "$ACC_TMP"
  exit "$rc"
}
trap cleanup EXIT

write_results() {
  [ -f "$ACC_TMP/results.jsonl" ] || return 0
  jq -s --arg at "$(date -Is)" --argjson budget "$budget_mib" --argjson idle "$idle_s" \
    '{runAt: $at, ramBudgetMib: $budget, idleTimeoutS: $idle} + add' \
    "$ACC_TMP/results.jsonl" >"$RESULTS"
  echo "== results: $RESULTS"
}

# --- section runner --------------------------------------------------------

declare -a summary=()
failed=0

# run_section N FN runs FN in a subshell with errexit, so a failure ends the
# section, not the run. Setup (0) runs in this shell: it exports IMP_TOKEN, and
# its failure ends the run.
run_section() {
  local n=$1 fn=$2 title=${SECTION_NAMES[$1]} t0 ms rc=0
  echo "== [$n] $title"
  t0=$(now_ms)
  if [ "$n" = 0 ]; then
    "$fn"
  else
    set +e
    (
      set -e
      "$fn"
    )
    rc=$?
    set -e
  fi
  ms=$(($(now_ms) - t0))
  local verdict=PASS
  if [ $rc -ne 0 ]; then
    verdict=FAIL
    failed=1
  fi
  printf -v line '[%s] %-16s %s %6d.%01d s' "$n" "$title" "$verdict" $((ms / 1000)) $((ms % 1000 / 100))
  echo "== $line"
  summary+=("$line")
  record "section$n" "$(jq -cn --arg v "$verdict" --argjson ms "$ms" '{verdict: $v, ms: $ms}')"
}

# --- 0 setup ---------------------------------------------------------------

reset_clean() {
  log "clean reset: tailnet logout, remove imp-dev, wipe $DATA"
  if docker inspect imp-dev >/dev/null 2>&1; then
    docker exec imp-dev /usr/local/lib/imp/tailscale-down.sh >/dev/null 2>&1 || true
  fi
  "$DEV" down
  if [ -d "$DATA" ]; then
    ensure_host_image
    # imp.xfs is root-owned; a stale loop device can outlive the container
    docker run --rm --privileged -v "$DATA:/d" "$IMP_HOST_IMAGE" bash -c '
      for dev in $(losetup -n -O NAME -j /d/imp.xfs 2>/dev/null); do losetup -d "$dev" || true; done
      find /d -mindepth 1 -delete'
  fi
}

# ensure_image NAME DIR [DOCKERFILE] builds an imp image unless it exists.
ensure_image() {
  if image_exists "$1"; then
    return 0
  fi
  log "image build $2 -> $1"
  local t0
  t0=$(now_ms)
  if [ -n "${3:-}" ]; then
    imp image build "$2" --name "$1" --file "$3" >/dev/null
  else
    imp image build "$2" --name "$1" >/dev/null
  fi
  log "image $1 built in $(($(now_ms) - t0)) ms"
}

s0_setup() {
  if [ $clean = 1 ]; then
    reset_clean
  elif [ $reuse = 0 ]; then
    "$DEV" down
  fi
  "$DEV" up
  IMP_TOKEN=$("$DEV" token)
  export IMP_TOKEN

  local got
  got=$(info_field ramBudgetMib)
  # safety: every later section relies on this budget to stay small
  expect_eq "$got" "$budget_mib" "impd RAM budget (dev.sh must pass IMP_RAM_BUDGET_MIB)"
  local avail_mib
  avail_mib=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
  [ "$avail_mib" -ge $((budget_mib + 2048)) ] \
    || fail "only $avail_mib MiB available; need budget $budget_mib + 2048 MiB headroom"

  # stale imps from an aborted --keep run would skew RAM numbers
  mapfile -t stale < <(prefixed_imps)
  if [ ${#stale[@]} -gt 0 ]; then
    log "removing ${#stale[@]} stale ${ACC_PREFIX}* imps"
    remove_imps "${stale[@]}"
  fi

  # base also tags imp/base:latest in the host docker, which hello builds FROM
  ensure_image base "$IMP_ROOT/images/base"
  ensure_image acc-tiny "$ACC_DIR/tiny"
  ensure_image acc-bare "$ACC_DIR/tiny" Dockerfile.bare
}

# --- 1 shell: new, exec, console -------------------------------------------

s1_shell() {
  local n=${ACC_PREFIX}shell t0 ms out rc

  t0=$(now_ms)
  out=$(imp new "$n" --image base)
  imp exec "$n" -- true
  ms=$(($(now_ms) - t0))
  held "$n"
  log "imp new + first exec: $ms ms (limit $max_new_ms ms)"
  record newPlusExecMs "$ms"
  expect_eq "${out%% *}" "$n" "imp new prints the name first"
  expect_le "$ms" "$max_new_ms" "imp new + first exec ms"

  expect_eq "$(imp exec "$n" -- echo hello-stdout)" hello-stdout "exec stdout"
  expect_eq "$(printf 'hello stdin\n' | imp exec "$n" -- cat)" "hello stdin" "exec stdin"
  expect_eq "$(seq 1 20000 | imp exec "$n" -- wc -l)" 20000 "exec large stdin"
  rc=0
  out=$(imp exec "$n" -- sh -c 'echo to-stderr >&2; exit 7' 2>&1 >/dev/null) || rc=$?
  expect_eq "$rc" 7 "exec exit code"
  expect_eq "$out" to-stderr "exec stderr"
  rc=0
  imp exec "$n" -- sh -c 'kill -TERM $$' || rc=$?
  expect_eq "$rc" 143 "exit code of a signalled process"

  out=$( (
    # shellcheck disable=SC2016 # expands in the imp, not here
    printf 'echo console-$((40 + 2))\n'
    sleep 1.5
    printf 'exit 5\n'
  ) | SHELL=/bin/bash script -qec "imp console $n" /dev/null | tr -d '\r' || true)
  [[ $out == *console-42* ]] || fail "console did not run the command: $(tail -3 <<<"$out")"
  rc=0
  (
    sleep 1
    printf 'exit 5\n'
  ) | SHELL=/bin/bash script -qec "imp console $n" /dev/null >/dev/null || rc=$?
  expect_eq "$rc" 5 "console exit code"

  [ $keep = 1 ] || remove_imps "$n"
}

# --- 2 docker inside an imp from images/base -------------------------------

s2_docker() {
  local n=${ACC_PREFIX}docker out
  new_imp "$n" --image base
  held "$n"
  wait_until 90 "dockerd in $n" imp exec "$n" -- docker info

  out=$(imp exec "$n" -- docker run --rm hello-world)
  [[ $out == *"Hello from Docker!"* ]] || fail "docker run hello-world: $out"
  log "docker run hello-world: ok"

  # shellcheck disable=SC2016 # runs in the imp
  out=$(imp exec "$n" -- sh -c '
    mkdir -p /tmp/acc-build && cd /tmp/acc-build
    printf "FROM busybox:1.37\nRUN echo built-\$((6 * 7)) > /built\nCMD [\"cat\", \"/built\"]\n" > Dockerfile
    docker build -q -t acc-built . >/dev/null && docker run --rm acc-built')
  expect_eq "$out" built-42 "docker build + run of the built image"
  log "docker build: ok"

  [ $keep = 1 ] || remove_imps "$n"
}

# --- 3 bring your own image ------------------------------------------------

s3_byo_image() {
  local n=${ACC_PREFIX}hello expected t0
  expected=$(cat "$IMP_ROOT/images/examples/hello/rootfs/srv/hello/index.html")
  if image_exists acc-hello; then
    imp image rm acc-hello
  fi
  t0=$(now_ms)
  imp image build "$IMP_ROOT/images/examples/hello" --name acc-hello >/dev/null
  log "imp image build images/examples/hello: $(($(now_ms) - t0)) ms"
  image_exists acc-hello || fail "acc-hello not in imp image ls"

  new_imp "$n" --image acc-hello
  held "$n"
  expect_eq "$(imp url "$n" | head -1)" "http://$n.imp.localhost:7080" "imp url"
  wait_until 30 "$n :8080 through the proxy" http_is "$n" / "$expected"
  log "http://$n.imp.localhost:7080/ -> $expected"

  [ $keep = 1 ] || remove_imps "$n"
}

# --- 4 checkpoint, restore, fork -------------------------------------------

# put_file NAME FILE CONTENT writes and syncs a file in an imp
put_file() { imp exec "$1" -- sh -c "echo $3 > $2 && sync"; }

# read_or_none NAME FILE prints the file or "none"
read_or_none() { imp exec "$1" -- sh -c "cat $2 2>/dev/null || echo none"; }

s4_checkpoint_fork() {
  local src=${ACC_PREFIX}cp fcp=${ACC_PREFIX}cp-fork-cp flive=${ACC_PREFIX}cp-fork-live t0
  new_imp "$src" --image acc-tiny
  held "$src"

  put_file "$src" /root/f v1
  t0=$(now_ms)
  imp checkpoint "$src" cp1 >/dev/null
  record checkpointMs "$(($(now_ms) - t0))"
  imp checkpoints "$src" | awk 'NR > 1 { print $2 }' | grep -qx cp1 || fail "cp1 not listed"

  put_file "$src" /root/f v2
  put_file "$src" /root/g extra
  t0=$(now_ms)
  imp restore "$src" cp1 >/dev/null
  wait_until 60 "$src back after restore" imp exec "$src" -- true
  record restoreMs "$(($(now_ms) - t0))"
  held "$src"
  expect_eq "$(read_or_none "$src" /root/f)" v1 "file after restore"
  expect_eq "$(read_or_none "$src" /root/g)" none "file created after the checkpoint"
  log "restore brought back v1 and dropped the later file"

  put_file "$src" /root/f v2

  # fork from the checkpoint
  t0=$(now_ms)
  imp fork "$src" "$fcp" --checkpoint cp1 >/dev/null
  imp start "$fcp" >/dev/null # a no-op if fork already booted it
  wait_until 60 "$fcp accepts exec" imp exec "$fcp" -- true
  record forkCheckpointMs "$(($(now_ms) - t0))"
  held "$fcp"
  expect_eq "$(read_or_none "$fcp" /root/f)" v1 "fork from cp1 sees the checkpoint"
  expect_eq "$(read_or_none "$src" /root/f)" v2 "source unchanged by the fork"
  assert_independent "$src" "$fcp" a

  # fork from the live disk
  t0=$(now_ms)
  imp fork "$src" "$flive" >/dev/null
  imp start "$flive" >/dev/null
  wait_until 60 "$flive accepts exec" imp exec "$flive" -- true
  record forkLiveMs "$(($(now_ms) - t0))"
  held "$flive"
  expect_eq "$(read_or_none "$flive" /root/f)" v2 "live fork sees the current disk"
  expect_eq "$(read_or_none "$flive" /root/only-a-src)" src "live fork sees earlier source writes"
  assert_independent "$src" "$flive" b
  log "forks from cp1 and from live are independent both ways"

  [ $keep = 1 ] || remove_imps "$fcp" "$flive" "$src"
}

# assert_independent SRC FORK TAG: a write on one side is invisible on the other
assert_independent() {
  local src=$1 fork=$2 tag=$3
  put_file "$fork" "/root/only-$tag-fork" fork
  put_file "$src" "/root/only-$tag-src" src
  expect_eq "$(read_or_none "$src" "/root/only-$tag-fork")" none "fork write seen in $src"
  expect_eq "$(read_or_none "$fork" "/root/only-$tag-src")" none "source write seen in $fork"
  expect_eq "$(read_or_none "$fork" "/root/only-$tag-fork")" fork "fork write in $fork"
}

# --- 5 idle sleep, RAM freed, wake on HTTP, memory intact ------------------

s5_sleep_wake() {
  local n=${ACC_PREFIX}mem id token used_before awake_before used_after awake_after t0 ms body
  new_imp "$n" --image acc-bare
  id=$(imp_field "$n" id)
  mem_proof_start "$n"
  token=$(mem_proof_token "$n")
  fc_running "$id" || fail "no firecracker process found for $n ($id)"
  sleep 3
  used_before=$(info_field ramUsedMib)
  awake_before=$(info_field awakeCount)

  log "waiting for $n to sleep on its own (idle timeout ${idle_s}s)"
  t0=$(now_ms)
  wait_until $((idle_s * 3 + 60)) "$n to sleep by itself" state_is "$n" sleeping
  record idleToSleepMs "$(($(now_ms) - t0))"
  wait_until 30 "firecracker for $n to exit" bash -c "! docker exec imp-dev pgrep -f 'firecracker.*imps/$id/'"
  used_after=$(info_field ramUsedMib)
  awake_after=$(info_field awakeCount)
  log "ramUsedMib $used_before -> $used_after, awakeCount $awake_before -> $awake_after"
  [ "$used_after" -lt "$used_before" ] || fail "ramUsedMib did not drop: $used_before -> $used_after"
  [ "$awake_after" -lt "$awake_before" ] || fail "awakeCount did not drop"
  record sleepFreedMib "$((used_before - used_after))"

  t0=$(now_ms)
  body=$(http_get "$n" /) || fail "the waking request to $n failed"
  ms=$(($(now_ms) - t0))
  expect_eq "$body" "$token" "the waking request returns the in-memory token"
  record wakeOnHttpMs "$ms"
  log "HTTP request woke $n in $ms ms and got the token"
  expect_eq "$(imp_state "$n")" running "state after the waking request"
  mem_proof_check "$n"

  # negative control: a cold boot loses the tmpfs and the process
  imp stop "$n" >/dev/null
  imp start "$n" >/dev/null
  wait_until 60 "$n after a cold boot" imp exec "$n" -- true
  body=$(HTTP_TIMEOUT=5 http_get "$n" / 2>/dev/null || true)
  [ "$body" != "$token" ] || fail "the token survived a cold boot; the proof is not memory-only"
  log "negative control: a cold boot does not have the token"

  [ $keep = 1 ] || remove_imps "$n"
}

# --- 6 scale: 30 imps under a RAM budget -----------------------------------

# monitor_budget FILE samples impd's and the independent firecracker RAM
# figures every ~0.5 s: "<ms> <ramUsedMib> <budget> <awake> <fcPssMib> <fcCount>"
monitor_budget() {
  local out=$1 info pss
  while :; do
    info=$(imp info --json 2>/dev/null | jq -r '"\(.ramUsedMib) \(.ramBudgetMib) \(.awakeCount)"' || true)
    pss=$(fc_pss 2>/dev/null || true)
    if [ -n "$info" ] && [ -n "$pss" ]; then
      echo "$(now_ms) $info $pss" >>"$out"
    fi
    sleep 0.5
  done
}

# budget_violations FILE prints samples over the budget
budget_violations() { awk -v b="$budget_mib" '$2 > b || $5 > b' "$1"; }

s6_scale() {
  local samples=$ACC_TMP/budget-samples create_ms=$ACC_TMP/create-ms wake_ms=$ACC_TMP/wake-ms
  local i n t0 used0 used1 per_imp field_ram fit bad
  : >"$samples"
  : >"$create_ms"
  : >"$wake_ms"
  local fill_cmd="mkdir -p /run/fill && mount -t tmpfs -o size=$((scale_fill + 16))m tmpfs /run/fill \
    && dd if=/dev/urandom of=/run/fill/blob bs=1M count=$scale_fill 2>/dev/null"

  expect_eq "$(info_field ramBudgetMib)" "$budget_mib" "ramBudgetMib"
  [ $((scale_memory * 2)) -le "$budget_mib" ] || fail "ACC_SCALE_MEMORY_MIB too big for the budget"

  # not local: the EXIT trap below runs after this function returns
  monitor_budget "$samples" &
  monitor_pid=$!
  # this section runs in a subshell, which has its own EXIT trap
  trap 'kill "$monitor_pid" 2>/dev/null || true' EXIT

  # per-imp RAM, measured on the first imp
  used0=$(info_field ramUsedMib)
  n=${ACC_PREFIX}scale-01
  t0=$(now_ms)
  imp new "$n" --image acc-tiny --memory "$scale_memory" >/dev/null
  echo $(($(now_ms) - t0)) >>"$create_ms"
  wait_until 60 "$n accepts exec" imp exec "$n" -- true
  imp exec "$n" -- sh -c "$fill_cmd"
  sleep 3
  used1=$(info_field ramUsedMib)
  field_ram=$(imp_field "$n" ramMib)
  per_imp=${field_ram:-$((used1 - used0))}
  [ "$per_imp" -gt 0 ] || fail "could not measure per-imp RAM (ramUsedMib $used0 -> $used1)"
  fit=$((budget_mib / per_imp))
  log "per-imp RAM ${per_imp} MiB (--memory $scale_memory, $scale_fill MiB filled); about $fit fit in $budget_mib MiB"
  record scale "$(jq -cn --argjson p "$per_imp" --argjson f "$fit" --argjson c "$scale_count" \
    --argjson m "$scale_memory" --argjson fill "$scale_fill" \
    '{perImpRamMib: $p, fitInBudget: $f, count: $c, memoryMib: $m, fillMib: $fill}')"

  for ((i = 2; i <= scale_count; i++)); do
    printf -v n '%sscale-%02d' "$ACC_PREFIX" "$i"
    t0=$(now_ms)
    imp new "$n" --image acc-tiny --memory "$scale_memory" >/dev/null
    echo $(($(now_ms) - t0)) >>"$create_ms"
    wait_until 60 "$n accepts exec" imp exec "$n" -- true
    imp exec "$n" -- sh -c "$fill_cmd"
    bad=$(budget_violations "$samples")
    [ -z "$bad" ] || fail "RAM over budget while creating $n: $(head -3 <<<"$bad")"
  done

  local total sleeping running
  total=$(imp ls --json | jq --arg p "${ACC_PREFIX}scale-" '[.[] | select(.name | startswith($p))] | length')
  expect_eq "$total" "$scale_count" "scale imps that exist"
  sleeping=$(imp ls --json | jq --arg p "${ACC_PREFIX}scale-" \
    '[.[] | select((.name | startswith($p)) and .state == "sleeping")] | length')
  running=$(imp ls --json | jq --arg p "${ACC_PREFIX}scale-" \
    '[.[] | select((.name | startswith($p)) and .state == "running")] | length')
  log "$scale_count exist: $running running, $sleeping sleeping"
  [ "$sleeping" -gt 0 ] || fail "no imp was slept to keep within the budget"

  # LRU: every sleeping imp was last active no later than every running one
  imp ls --json | jq -e --arg p "${ACC_PREFIX}scale-" '
    [.[] | select(.name | startswith($p))] as $s
    | ([$s[] | select(.state == "sleeping") | .lastActiveAt] | max) as $slept
    | ([$s[] | select(.state == "running") | .lastActiveAt] | min) as $awake
    | $slept == null or $awake == null or $slept <= $awake' >/dev/null \
    || fail "sleeping imps are not the least recently active"

  # wake sweep: each request to a sleeping imp must wake it within budget
  local state body
  for ((i = 1; i <= scale_count; i++)); do
    printf -v n '%sscale-%02d' "$ACC_PREFIX" "$i"
    state=$(imp_state "$n")
    t0=$(now_ms)
    body=$(http_get "$n" /) || fail "request to $n ($state) failed"
    if [ "$state" = sleeping ]; then
      echo $(($(now_ms) - t0)) >>"$wake_ms"
    fi
    expect_eq "$body" acc-tiny-ok "response from $n"
  done
  log "woke $(wc -l <"$wake_ms") sleeping imps by HTTP"
  [ -s "$wake_ms" ] || fail "no sleeping imp to measure a wake on"

  # a request that cannot fit even after sleeping everything
  local rc=0 err
  err=$(imp new "${ACC_PREFIX}huge" --image acc-tiny --memory $((budget_mib + 1024)) 2>&1 >/dev/null) || rc=$?
  [ $rc -ne 0 ] || fail "an imp larger than the budget was created"
  [[ $err == *RAM_BUDGET_EXCEEDED* ]] || fail "expected RAM_BUDGET_EXCEEDED, got: $err"
  if imp_exists "${ACC_PREFIX}huge"; then
    remove_imps "${ACC_PREFIX}huge"
    fail "the rejected imp was left behind"
  fi
  log "oversized imp rejected: ${err#imp: }"

  sleep 2
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  bad=$(budget_violations "$samples")
  [ -z "$bad" ] || fail "RAM over budget: $(head -3 <<<"$bad")"

  local max_used max_pss max_awake n_samples
  read -r max_used max_pss max_awake n_samples < <(awk '
    { if ($2 > u) u = $2; if ($5 > p) p = $5; if ($4 > a) a = $4 }
    END { print u + 0, p + 0, a + 0, NR }' "$samples")
  log "budget held over $n_samples samples: max ramUsedMib $max_used, max firecracker PSS $max_pss, max awake $max_awake"
  record scaleBudget "$(jq -cn --argjson u "$max_used" --argjson p "$max_pss" --argjson a "$max_awake" \
    --argjson s "$n_samples" --argjson sl "$sleeping" \
    '{maxRamUsedMib: $u, maxFirecrackerPssMib: $p, maxAwake: $a, samples: $s, sleepingAfterCreate: $sl}')"
  record createMs "$(stats "$create_ms")"
  record wakeMs "$(stats "$wake_ms")"
  log "create ms $(stats "$create_ms")"
  log "wake ms   $(stats "$wake_ms")"
  # the scale imps stay for section 7
}

# --- 7 restart survival ----------------------------------------------------

# inventory prints every imp (without volatile fields) and its checkpoint ids
inventory() {
  local name
  imp ls --json | jq -S '[.[] | {name, id, image, slot, port, vcpus, memoryMib}] | sort_by(.name)'
  imp ls --json | jq -r '.[].name' | sort | while read -r name; do
    echo "$name: $(imp checkpoints "$name" | awk 'NR > 1 { print $1 }' | sort | tr '\n' ' ')"
  done
}

impd_pid() { docker exec imp-dev pgrep -f 'bun .*/daemon/src/main.ts' | head -1; }

impd_replaced() {
  local pid
  pid=$(impd_pid)
  [ -n "$pid" ] && [ "$pid" != "$1" ]
}

s7_restart() {
  local disk=${ACC_PREFIX}r-disk mem=${ACC_PREFIX}r-mem token t0 body
  new_imp "$disk" --image acc-tiny
  held "$disk"
  put_file "$disk" /root/f r1
  imp checkpoint "$disk" r1 >/dev/null
  put_file "$disk" /root/f r2

  new_imp "$mem" --image acc-bare
  mem_proof_start "$mem"
  token=$(mem_proof_token "$mem")
  # the idle sleeper may get there first
  imp sleep "$mem" >/dev/null 2>&1 || true
  wait_until 60 "$mem asleep" state_is "$mem" sleeping

  inventory >"$ACC_TMP/inventory-before"
  log "$(imp ls --json | jq length) imps before the restart"
  # dev.sh restart can return while the old impd still sleeps imps and
  # answers /health, so wait for a new impd process
  local old_pid
  old_pid=$(impd_pid)
  [ -n "$old_pid" ] || fail "no impd process in imp-dev"
  t0=$(now_ms)
  "$DEV" restart
  wait_until 180 "a new impd process" impd_replaced "$old_pid"
  wait_until 120 "the new impd ready" bash -c 'curl -fsS http://localhost:7070/health | grep -q "\"ready\":true"'
  record restartMs "$(($(now_ms) - t0))"
  inventory >"$ACC_TMP/inventory-after"
  if ! diff -u "$ACC_TMP/inventory-before" "$ACC_TMP/inventory-after" >"$ACC_TMP/inventory-diff"; then
    cat "$ACC_TMP/inventory-diff" >&2
    fail "imps or checkpoints differ after the restart"
  fi
  log "imps and checkpoints identical after the restart"

  body=$(http_get "$mem" /) || fail "the waking request to $mem failed after the restart"
  expect_eq "$body" "$token" "memory token after restart + wake"
  mem_proof_check "$mem"
  log "slept imp kept its memory across the restart"

  # the restart slept it; test the checkpoint, not restore-while-asleep
  imp wake "$disk" >/dev/null
  wait_until 60 "$disk awake" imp exec "$disk" -- true
  imp restore "$disk" r1 >/dev/null
  wait_until 60 "$disk after restore" imp exec "$disk" -- true
  expect_eq "$(read_or_none "$disk" /root/f)" r1 "file after restoring a pre-restart checkpoint"
  log "pre-restart checkpoint restores"
}

# --- 8 tailscale -----------------------------------------------------------

has_authkey() {
  [ -n "${TAILSCALE_AUTHKEY:-}" ] || grep -q '^TAILSCALE_AUTHKEY=..' "$IMP_ROOT/.env" 2>/dev/null
}

ts_running() { [ "$(info_field tailscale.state)" = Running ]; }

# tailnet_get URL EXPECTED: the body over the tailnet equals EXPECTED
tailnet_get() { [ "$(curl -fsS --max-time 30 "$1")" = "$2" ]; }

s8_tailscale() {
  local n=${ACC_PREFIX}ts host ip port url
  has_authkey || fail "TAILSCALE_AUTHKEY is not set and not in .env"
  [ "$(tailscale status --json 2>/dev/null | jq -r .BackendState)" = Running ] \
    || fail "this machine is not on the tailnet (tailscale status)"
  wait_until 120 "impd tailscale state Running" ts_running
  host=$(info_field tailscale.hostname)
  [ -n "$host" ] && [ "$host" != null ] || fail "imp info has no tailscale hostname"

  ip=$(tailscale status --json | jq -r --arg h "$host" '
    [.Peer[]? | select(.HostName == $h or (.DNSName | startswith($h + ".")))][0].TailscaleIPs[0] // empty')
  [[ $ip == 100.* ]] || fail "no tailnet peer $host seen from this machine (got '$ip')"
  log "tailnet host $host at $ip"

  new_imp "$n" --image acc-tiny
  held "$n"
  port=$(imp_field "$n" port)
  url=$(imp url "$n" | sed -n 2p)
  [ -n "$url" ] || fail "imp url prints no tailnet URL"
  wait_until 60 "http://$ip:$port/ over the tailnet" tailnet_get "http://$ip:$port/" acc-tiny-ok
  wait_until 60 "$url over the tailnet" tailnet_get "$url" acc-tiny-ok
  log "$url and http://$ip:$port/ answer from this tailnet member"

  imp hold "$n" 0 >/dev/null
  imp sleep "$n" >/dev/null
  wait_until 60 "$n asleep" state_is "$n" sleeping
  tailnet_get "$url" acc-tiny-ok || fail "a tailnet request did not wake $n"
  log "a tailnet request wakes a sleeping imp"

  [ $keep = 1 ] || remove_imps "$n"
}

# --- main ------------------------------------------------------------------

run_section 0 s0_setup
if [ $failed = 1 ]; then
  echo "== setup failed; no section ran" >&2
  exit 1
fi

sections=(s1_shell s2_docker s3_byo_image s4_checkpoint_fork s5_sleep_wake s6_scale s7_restart s8_tailscale)
for i in "${!sections[@]}"; do
  if wanted $((i + 1)); then
    run_section $((i + 1)) "${sections[$i]}"
  fi
done

echo "== summary"
printf '   %s\n' "${summary[@]}"
if [ $failed = 1 ]; then
  echo "== FAIL"
  exit 1
fi
echo "== PASS"
