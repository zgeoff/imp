#!/bin/bash
# Measure wakes of an imp put to sleep right after a cold boot: the case a
# host kernel before Linux 6.7 makes slow (docs/architecture/sleep-and-wake.md#young-guests).
#
#   scripts/bench-wake.sh [--cycles N] [--awake S] [--limit-ms MS] [--memory M]
#
# Each cycle stops and starts the imp, waits --awake seconds (default 0),
# sleeps it and times `imp wake` as the client sees it, CLI start included.
# It fails when the median wake passes --limit-ms (default 500). A slow wake
# takes 700-1100 ms on an affected host; a normal one 100-200 ms.
#
# It drives impd through the imp CLI, so it runs against any host: set
# IMP_URL and IMP_TOKEN, or use the saved login. IMP_BIN picks the CLI
# (default: scripts/imp from this checkout). To see the effect itself, run
# impd with IMP_SLEEP_MIN_GUEST_UPTIME_MS=0; with the default, impd waits
# out the young guest and the wakes stay fast.
set -euo pipefail

cycles=3
awake=0
limit_ms=500
memory=1g

while [ $# -gt 0 ]; do
  case $1 in
    --cycles) cycles=$2 ;;
    --awake) awake=$2 ;;
    --limit-ms) limit_ms=$2 ;;
    --memory) memory=$2 ;;
    *)
      echo "bench-wake: unknown option $1" >&2
      exit 2
      ;;
  esac
  shift 2
done

imp_bin=${IMP_BIN:-$(dirname "$0")/imp}
name=bench-wake-$$

now_ms() {
  echo $(($(date +%s%N) / 1000000))
}

imp() {
  "$imp_bin" "$@" >/dev/null
}

cleanup() {
  imp rm "$name" || true
}
trap cleanup EXIT

# the host kernel decides the result: record `uname -r` on the impd host with it
echo "bench-wake: $cycles cycles, awake ${awake}s, limit ${limit_ms}ms"

imp new "$name" --memory "$memory"

wakes=()
for cycle in $(seq 1 "$cycles"); do
  imp stop "$name"
  imp start "$name"
  sleep "$awake"

  started=$(now_ms)
  imp sleep "$name"
  slept=$(now_ms)
  imp wake "$name"
  woke=$(now_ms)

  wakes+=($((woke - slept)))
  echo "bench-wake: cycle $cycle: sleep $((slept - started))ms, wake $((woke - slept))ms"
done

median=$(printf '%s\n' "${wakes[@]}" | sort -n | awk '{ v[NR] = $1 } END { print v[int((NR + 1) / 2)] }')

echo "bench-wake: median wake ${median}ms"

if [ "$median" -gt "$limit_ms" ]; then
  echo "bench-wake: the median wake passes ${limit_ms}ms" >&2
  exit 1
fi
