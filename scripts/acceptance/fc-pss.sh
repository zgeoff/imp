#!/bin/bash
# Runs in the imp host container: prints "<pss MiB> <count>" summed over every
# firecracker process, an independent check of the RAM impd reports.
set -euo pipefail
kib=0
count=0
for pid in $(pgrep -x firecracker || true); do
  v=$(awk '/^Pss:/ { print $2 }' "/proc/$pid/smaps_rollup" 2>/dev/null || true)
  kib=$((kib + ${v:-0}))
  count=$((count + 1))
done
echo "$((kib / 1024)) $count"
