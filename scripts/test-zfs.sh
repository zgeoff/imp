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
work=${IMP_ZFS_TEST_DIR:-$(mktemp -d)}
gib=${IMP_ZFS_TEST_GIB:-4}
pool=imptest$$
mnt=$work/mnt

echo "test-zfs: zfs $(cat /sys/module/zfs/version) (module), $(zfs version | head -1) (userland)"

# Everything under $mnt is unmounted before the pool goes: the tests mount
# datasets there, and a test that fails can leave them.
cleanup() {
  umount -R "$mnt" 2>/dev/null || true
  zpool destroy "$pool" 2>/dev/null || true
  rm -f "$work/pool.img"
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
