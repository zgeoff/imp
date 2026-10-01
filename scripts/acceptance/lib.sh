# shellcheck shell=bash
# Helpers for scripts/acceptance.sh. Source it after scripts/lib.sh.
#
# Expects: IMP_ROOT, ACC_TMP (scratch dir), ACC_PREFIX (name prefix).

now_ms() { echo $(($(date +%s%N) / 1000000)); }

log() { echo "    $*"; }

fail() {
  echo "    FAIL: $*" >&2
  exit 1
}

# expect_eq ACTUAL EXPECTED WHAT
expect_eq() {
  [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"
}

# expect_le ACTUAL LIMIT WHAT (integers)
expect_le() {
  [ "$1" -le "$2" ] || fail "$3: $1 > $2"
}

# wait_until TIMEOUT_S WHAT CMD... runs CMD (quietly) every 0.5 s until it
# succeeds; fails the section after TIMEOUT_S.
wait_until() {
  local timeout=$1 what=$2
  shift 2
  local deadline=$((SECONDS + timeout))
  until "$@" >/dev/null 2>&1; do
    [ $SECONDS -lt $deadline ] || fail "timed out after ${timeout}s waiting for: $what"
    sleep 0.5
  done
}

# --- impd queries -----------------------------------------------------------

info_field() { imp info --json | jq -r ".$1"; }

# imp_field NAME FIELD prints one field of one imp from `imp ls --json`.
imp_field() {
  imp ls --json | jq -r --arg n "$1" --arg f "$2" '.[] | select(.name == $n) | .[$f] // empty'
}

imp_state() { imp_field "$1" state; }

state_is() { [ "$(imp_state "$1")" = "$2" ]; }

imp_exists() { imp ls --json | jq -e --arg n "$1" 'any(.[]; .name == $n)' >/dev/null; }

# prefixed_imps lists the names of every imp this test owns.
prefixed_imps() {
  imp ls --json | jq -r --arg p "$ACC_PREFIX" '.[] | select(.name | startswith($p)) | .name'
}

image_exists() {
  imp image ls | awk 'NR > 1 { print $1 }' | grep -qx "$1"
}

# fc_running IMP_ID: a firecracker process for this imp exists in the host
# container. Assumes its argv holds the imp dir (imps/<id>/run/api.sock).
fc_running() {
  docker exec imp-dev pgrep -f "firecracker.*imps/$1/" >/dev/null 2>&1
}

# fc_pss prints "<MiB> <count>" summed over all firecracker processes.
fc_pss() {
  docker exec imp-dev bash /src/scripts/acceptance/fc-pss.sh
}

# --- HTTP through the proxy ------------------------------------------------

# http_get NAME [PATH] fetches http://NAME.imp.localhost:7080PATH, pinned to
# 127.0.0.1 so it does not rely on *.localhost resolving.
http_get() {
  curl -fsS --max-time "${HTTP_TIMEOUT:-30}" --resolve "$1.imp.localhost:7080:127.0.0.1" \
    "http://$1.imp.localhost:7080${2:-/}"
}

# http_is NAME PATH BODY: the response body equals BODY.
http_is() { [ "$(http_get "$1" "$2")" = "$3" ]; }

# --- lifecycle -------------------------------------------------------------

# new_imp NAME ARGS... creates an imp and waits until exec works.
new_imp() {
  local name=$1
  shift
  imp new "$name" "$@" >/dev/null
  wait_until 60 "$name accepts exec" imp exec "$name" -- true
}

# held NAME keeps an imp awake for the test, so the short idle timeout does not
# sleep it between steps (a sleeping disk must not be checkpointed).
held() { imp hold "$1" 30m >/dev/null; }

remove_imps() {
  local name
  for name in "$@"; do
    imp rm "$name" >/dev/null 2>&1 || true
  done
}

# --- memory proof (DESIGN.md 2.8, docs/sleep-findings.md section 1) --------

# mem_proof_start NAME starts busybox httpd on :8080 in an acc-bare imp,
# serving a random token from a fresh tmpfs. The token exists only in guest
# memory: a cold boot loses the tmpfs and the process. Saves token, pid,
# process start time and boot id to $ACC_TMP/memproof-NAME.
mem_proof_start() {
  local name=$1 token out
  token=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  out=$(imp exec "$name" -- sh -c "
    mkdir -p /run/acc && mount -t tmpfs -o size=1m tmpfs /run/acc
    echo $token > /run/acc/index.html
    setsid httpd -p 8080 -h /run/acc </dev/null >/dev/null 2>&1
    sleep 0.3
    pid=\$(pidof httpd)
    echo \$pid \$(cut -d' ' -f22 /proc/\$pid/stat) \$(cat /proc/sys/kernel/random/boot_id)
  ")
  [ "$(wc -w <<<"$out")" = 3 ] || fail "memory proof setup in $name printed: $out"
  echo "$token $out" >"$ACC_TMP/memproof-$name"
  wait_until 30 "$name serves the token" http_is "$name" / "$token"
}

# mem_proof_token NAME prints the saved token.
mem_proof_token() { cut -d' ' -f1 "$ACC_TMP/memproof-$1"; }

# mem_proof_check NAME: same httpd pid, start time and boot id as at start.
mem_proof_check() {
  local name=$1 pid start boot now
  read -r _ pid start boot <"$ACC_TMP/memproof-$name"
  now=$(imp exec "$name" -- sh -c \
    "echo $pid \$(cut -d' ' -f22 /proc/$pid/stat) \$(cat /proc/sys/kernel/random/boot_id)")
  expect_eq "$now" "$pid $start $boot" "httpd pid, start time and boot id in $name"
}

# --- results ---------------------------------------------------------------

# record KEY JSON adds one value to the results file.
record() {
  jq -cn --arg k "$1" --argjson v "$2" '{($k): $v}' >>"$ACC_TMP/results.jsonl"
}

# percentile P reads integers on stdin and prints the P-th percentile
# (nearest rank), or null for no input.
percentile() {
  sort -n | awk -v p="$1" '
    { a[NR] = $1 }
    END {
      if (NR == 0) { print "null"; exit }
      i = int((p * NR + 99) / 100); if (i < 1) i = 1
      print a[i]
    }'
}

# stats FILE prints {"n","p50","p95","max"} for a file of integers.
stats() {
  jq -cn --argjson n "$(wc -l <"$1")" \
    --argjson p50 "$(percentile 50 <"$1")" \
    --argjson p95 "$(percentile 95 <"$1")" \
    --argjson max "$(percentile 100 <"$1")" \
    '{n: $n, p50: $p50, p95: $p95, max: $max}'
}
