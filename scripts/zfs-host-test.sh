#!/bin/bash
# The ZFS storage backend on a real host, in two parts:
#
#   1. scripts/test-zfs.sh: the backend's tests against a throwaway pool.
#   2. A dev instance on a second throwaway pool runs e2e suites (default
#      checkpoints and sleep). impd's log lines and the suites' metrics then
#      give the STATUS.md numbers on ZFS: checkpoint, restore, fork, sleep.
#
#   scripts/zfs-host-test.sh
#
# Both pools live in sparse files under IMP_ZFS_TEST_DIR (default a new dir
# in /var/tmp); no disk is touched, and both pools go when it ends. Run it as
# a user with sudo and docker, on a host with KVM and the zfs module loaded
# (sudo modprobe zfs). The module must be OpenZFS 2.x, the host image's
# major version; a minor skew only warns. Needs the guest kernel and system
# drive that scripts/dev.sh needs.
#
# Env: IMP_DEV_PORT_OFFSET (default 300) for the dev instance imp-zfs;
#      IMP_ZFS_BENCH_GIB (default 40) sizes the second pool's file;
#      IMP_ZFS_E2E_SUITES (default checkpoints,sleep) picks the suites (CI adds
#      lifecycle, disks, backups, boot-templates and moves, whose second impd
#      gets a dataset of its own);
#      IMP_ZFS_TEST_UNIT=0 skips part 1 (the zfs CI job runs it on its own).
#      The summary is also written to <dir>/summary.txt.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

work=${IMP_ZFS_TEST_DIR:-$(mktemp -d /var/tmp/imp-zfs.XXXXXX)}
pool=impbench$$
gib=${IMP_ZFS_BENCH_GIB:-40}

[ -r /sys/module/zfs/version ] || { echo "zfs-host-test: load the zfs module first (sudo modprobe zfs)" >&2; exit 1; }
echo "zfs-host-test: zfs module $(cat /sys/module/zfs/version); results in $work"

if [ "${IMP_ZFS_TEST_UNIT:-1}" != 0 ]; then
  sudo env "PATH=$PATH" IMP_ZFS_TEST_DIR="$work/unit" "$IMP_ROOT/scripts/test-zfs.sh"
  rmdir "$work/unit" 2>/dev/null || true
fi

export IMP_DEV_NAME=imp-zfs
export IMP_DEV_PORT_OFFSET=${IMP_DEV_PORT_OFFSET:-300}
export IMP_DEV_DATA=$work/data
export IMP_STORAGE_BACKEND=zfs
export IMP_ZFS_ROOT=$pool/imp

# The results stay in $work; the pool file goes unless the pool will not.
# The moves suites' B and its network go first, as a killed run leaves them
# up, with B's dataset busy in the pool.
cleanup() {
  docker logs "$IMP_DEV_NAME" >"$work/impd.log" 2>&1 || true
  if docker container inspect "$IMP_DEV_NAME-mv-b" >/dev/null 2>&1; then
    docker logs "$IMP_DEV_NAME-mv-b" >"$work/impd-mv-b.log" 2>&1 || true
  fi
  IMP_DEV_NAME=$IMP_DEV_NAME-mv-b "$IMP_ROOT/scripts/dev.sh" down || true
  "$IMP_ROOT/scripts/dev.sh" down || true
  docker network rm "$IMP_DEV_NAME-mv" >/dev/null 2>&1 || true
  if sudo zpool list "$pool" >/dev/null 2>&1 && ! sudo zpool destroy -f "$pool"; then
    echo "zfs-host-test: could not destroy $pool; its file stays at $work/bench.img" >&2
    return
  fi
  sudo rm -f "$work/bench.img"
}
trap cleanup EXIT

truncate -s "${gib}G" "$work/bench.img"
# what deploy/bootstrap.sh gives the root dataset; impd sets recordsize=16K
# on the datasets that hold disks
sudo zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa \
  "$pool" "$work/bench.img"
sudo zfs create -o mountpoint=legacy "$IMP_ZFS_ROOT"
# the moves suites' second impd, B, on a dataset of its own (test/e2e/lib/move-hosts.ts)
sudo zfs create -o mountpoint=legacy "$IMP_ZFS_ROOT-mv-b"

# summarize LABEL REGEX: count, min, median and max of the ms in each match
summarize() {
  { grep -oE "$2" "$work/impd.log" || true; } | grep -oE '[0-9]+ms$' | tr -d ms | sort -n |
    awk -v label="$1" '{ v[NR] = $1 } END {
      if (NR == 0) { printf "%-22s no samples\n", label; exit }
      printf "%-22s n=%d  min %d  median %d  max %d ms\n", label, NR, v[1], v[int((NR + 1) / 2)], v[NR]
    }'
}

report() {
  echo "zfs-host-test: impd timings on ZFS (STATUS.md has the XFS ones)"
  summarize checkpoint 'checkpoint cp-[a-z0-9]+ in [0-9]+ms'
  summarize restore 'restored cp-[a-z0-9]+ in [0-9]+ms'
  summarize 'disk clone (new/fork)' 'disk cloned in [0-9]+ms'
  summarize sleep ': asleep in [0-9]+ms'
  grep -oE 'mem file [0-9]+ MiB on disk' "$work/impd.log" | sort | uniq -c || true
  echo
  echo "zfs-host-test: the suites' own metrics, CLI round trip included"
  grep -E '^ +(newPlusExecMs|checkpointMs|restoreMs|forkCheckpointMs|forkLiveMs|idleToSleepMs|wakeOnHttpMs|backup[A-Za-z]+): ' \
    "$work/e2e.log" || true
  echo
  sudo zfs list -r -t all -o name,used,refer,compressratio,recordsize "$pool"
}

# A failed suite still gets its report; the script then exits with the
# suites' status.
set +e
"$IMP_ROOT/scripts/test-e2e.sh" --only "${IMP_ZFS_E2E_SUITES:-checkpoints,sleep}" 2>&1 |
  tee "$work/e2e.log"
status=${PIPESTATUS[0]}
set -e

docker logs "$IMP_DEV_NAME" >"$work/impd.log" 2>&1 || true

echo
report | tee "$work/summary.txt" || true
[ "$status" = 0 ] || exit "$status"
