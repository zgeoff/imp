#!/bin/bash
# The ZFS storage backend on a real host, in two parts:
#
#   1. scripts/test-zfs.sh: the backend's tests against a throwaway pool.
#   2. A dev instance on a second throwaway pool runs the checkpoints and
#      sleep e2e suites. impd's own log lines then give the STATUS.md
#      numbers on ZFS: checkpoint, restore, fork (disk clone) and sleep.
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
#      IMP_ZFS_BENCH_GIB (default 40) sizes the second pool's file.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

work=${IMP_ZFS_TEST_DIR:-$(mktemp -d /var/tmp/imp-zfs.XXXXXX)}
pool=impbench$$
gib=${IMP_ZFS_BENCH_GIB:-40}

[ -r /sys/module/zfs/version ] || { echo "zfs-host-test: load the zfs module first (sudo modprobe zfs)" >&2; exit 1; }
echo "zfs-host-test: zfs module $(cat /sys/module/zfs/version); results in $work"

sudo env "PATH=$PATH" IMP_ZFS_TEST_DIR="$work/unit" "$IMP_ROOT/scripts/test-zfs.sh"
rmdir "$work/unit" 2>/dev/null || true

export IMP_DEV_NAME=imp-zfs
export IMP_DEV_PORT_OFFSET=${IMP_DEV_PORT_OFFSET:-300}
export IMP_DEV_DATA=$work/data
export IMP_STORAGE_BACKEND=zfs
export IMP_ZFS_ROOT=$pool/imp

# The results stay in $work; the pool file goes unless the pool will not.
cleanup() {
  docker logs "$IMP_DEV_NAME" >"$work/impd.log" 2>&1 || true
  "$IMP_ROOT/scripts/dev.sh" down || true
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

"$IMP_ROOT/scripts/test-e2e.sh" --only checkpoints,sleep 2>&1 | tee "$work/e2e.log"

docker logs "$IMP_DEV_NAME" >"$work/impd.log" 2>&1

# summarize LABEL REGEX: count, min, median and max of the ms in each match
summarize() {
  grep -oE "$2" "$work/impd.log" | grep -oE '[0-9]+ms$' | tr -d ms | sort -n |
    awk -v label="$1" '{ v[NR] = $1 } END {
      if (NR == 0) { printf "%-22s no samples\n", label; exit }
      printf "%-22s n=%d  min %d  median %d  max %d ms\n", label, NR, v[1], v[int((NR + 1) / 2)], v[NR]
    }'
}

echo
echo "zfs-host-test: impd timings on ZFS (STATUS.md has the XFS ones)"
summarize checkpoint 'checkpoint cp-[a-z0-9]+ in [0-9]+ms'
summarize restore 'restored cp-[a-z0-9]+ in [0-9]+ms'
summarize 'disk clone (new/fork)' 'disk cloned in [0-9]+ms'
summarize sleep ': asleep in [0-9]+ms'
grep -oE 'mem file [0-9]+ MiB on disk' "$work/impd.log" | sort | uniq -c || true
echo
sudo zfs list -r -o name,used,refer,compressratio,recordsize "$pool"
