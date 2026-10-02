#!/bin/bash
# Run the ZFS storage backend's tests against a real pool: a sparse file
# becomes a throwaway pool, the tests in packages/daemon/src/storage/zfs run
# on it, and the pool and file are destroyed. No disk is touched.
#
#   sudo env "PATH=$PATH" scripts/test-zfs.sh
#
# Needs root, the zfs kernel module loaded and zfsutils installed. The `zfs`
# CI job runs it on a GitHub runner; on a host, scripts/zfs-host-test.sh does.
#
# Env: IMP_ZFS_TEST_DIR (default a new temp dir) holds the pool file and
#      the mount point. IMP_ZFS_TEST_GIB (default 4) sizes the pool file.
set -euo pipefail

fail() {
  echo "test-zfs: $1" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "run as root: sudo env \"PATH=\$PATH\" $0"
[ -r /sys/module/zfs/version ] || fail "the zfs kernel module is not loaded (modprobe zfs)"
command -v zpool >/dev/null || fail "zpool is missing; install zfsutils-linux"

repo=$(cd "$(dirname "$0")/.." && pwd)
made_work=
if [ -n "${IMP_ZFS_TEST_DIR:-}" ]; then
  work=$IMP_ZFS_TEST_DIR
else
  work=$(mktemp -d)
  made_work=1
fi
gib=${IMP_ZFS_TEST_GIB:-4}
pool=imptest$$
mnt=$work/mnt

echo "test-zfs: zfs $(cat /sys/module/zfs/version) (module), $(zfs version | head -1) (userland)"

# Everything under $mnt is unmounted before the pool goes: the tests mount
# datasets there, and a test that fails can leave them. A pool that will not
# go keeps its file, so it can still be imported and destroyed by hand.
cleanup() {
  umount -R "$mnt" 2>/dev/null || true
  if zpool list "$pool" >/dev/null 2>&1 && ! zpool destroy -f "$pool"; then
    echo "test-zfs: could not destroy $pool; its file stays at $work/pool.img" >&2
    return
  fi
  rm -f "$work/pool.img"
  rmdir "$mnt" 2>/dev/null || true
  if [ -n "$made_work" ]; then
    rmdir "$work" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p "$mnt"
truncate -s "${gib}G" "$work/pool.img"
# the properties deploy/bootstrap.sh gives the imp root dataset
zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa \
  "$pool" "$work/pool.img"
zfs create -o mountpoint=legacy "$pool/imp"
mount -t zfs "$pool/imp" "$mnt"

cd "$repo"
IMP_TEST_ZFS_ROOT=$pool/imp IMP_TEST_ZFS_DIR=$mnt bun test packages/daemon/src/storage/zfs
