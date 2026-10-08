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
#      the mount point; it may exist, but not its pool.img or mnt, and it is
#      made with its parents when it does not.
#      IMP_ZFS_TEST_GIB (default 4) sizes the pool file.
#      IMP_ZFS_MODULE_VERSION_FILE (default /sys/module/zfs/version) is
#      where the loaded module's version is read, for the script's tests.
#
# The run owns only what it creates: it refuses a pool name that is taken,
# or a pool.img or mnt already in the work dir, before it touches anything,
# and its cleanup releases only what it made, so a failed step never takes
# another run's pool, file or mount. It destroys the pool only when
# `zpool status -P` shows its vdev is this run's pool.img, and never removes
# a pool.img that a pool still uses.
set -euo pipefail

fail() {
  echo "test-zfs: $1" >&2
  exit 1
}

module_version=${IMP_ZFS_MODULE_VERSION_FILE:-/sys/module/zfs/version}

[ "$(id -u)" = 0 ] || fail "run as root: sudo env \"PATH=\$PATH\" $0"
[ -r "$module_version" ] || fail "the zfs kernel module is not loaded (modprobe zfs)"
command -v zpool >/dev/null || fail "zpool is missing; install zfsutils-linux"

repo=$(cd "$(dirname "$0")/.." && pwd)
gib=${IMP_ZFS_TEST_GIB:-4}
pool=imptest$$
work=${IMP_ZFS_TEST_DIR:-}

# a generated name is not ownership: refuse one that is already in use, and
# a work dir that already holds a pool file or a mount point
if zpool list "$pool" >/dev/null 2>&1; then
  fail "a pool named $pool already exists; refusing to touch it"
fi
if [ -n "$work" ]; then
  if [ -e "$work/pool.img" ] || [ -L "$work/pool.img" ]; then
    fail "$work/pool.img already exists; refusing to touch it"
  fi
  if [ -e "$work/mnt" ] || [ -L "$work/mnt" ]; then
    fail "$work/mnt already exists; refusing to touch it"
  fi
fi

echo "test-zfs: zfs $(cat "$module_version") (module), $(zfs version | head -1) (userland)"

# what this run made, so cleanup releases that and nothing else; the pool
# is proven by its vdev instead, since a signal during its create runs the
# trap only once the create has finished
made_work=
made_mnt=
made_img=

# the test run, when it runs, so a signal can stop it first
child=

# img_use [POOL]: 0 when POOL, or any pool, lists this run's file as a vdev,
# 1 when none does, 2 when zpool cannot say; a vdev path may hold spaces
img_use() {
  local pools out
  pools=$(zpool list -H -o name 2>/dev/null) || return 2
  if [ -n "${1:-}" ] && ! grep -qxF -- "$1" <<<"$pools"; then
    return 1
  fi
  out=$(zpool status -P "$@" 2>/dev/null) || return 2
  awk -v img="$img" '{
    sub(/^[ \t]+/, "")
    rest = substr($0, length(img) + 1)
    if (index($0, img) == 1 && (rest == "" || rest ~ /^[ \t]/)) found = 1
  } END { exit !found }' <<<"$out"
}

# In reverse order. Everything under $mnt is unmounted before the pool goes:
# the tests mount datasets there, and a test that fails can leave them. A
# pool that will not go keeps its file, so it can still be imported and
# destroyed by hand, and the run fails.
cleanup() {
  local status=$?
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  if [ -n "$made_mnt" ]; then
    umount -R "$mnt" 2>/dev/null || true
  fi
  if [ -n "$made_img" ]; then
    local use=0
    img_use "$pool" || use=$?
    if [ "$use" = 0 ] && ! zpool destroy -f "$pool"; then
      echo "test-zfs: could not destroy $pool; its file stays at $img" >&2
      [ "$status" != 0 ] || status=1
      exit "$status"
    fi
    # never the file of a pool that is still there, or may be
    use=0
    img_use || use=$?
    if [ "$use" != 1 ]; then
      if [ "$use" = 0 ]; then
        echo "test-zfs: a pool still uses $img; it stays" >&2
      else
        echo "test-zfs: zpool cannot say which pools use $img; it stays" >&2
      fi
      [ "$status" != 0 ] || status=1
      exit "$status"
    fi
    rm -f "$img"
  fi
  if [ -n "$made_mnt" ]; then
    rmdir "$mnt" 2>/dev/null || true
  fi
  if [ -n "$made_work" ]; then
    rmdir "$work" 2>/dev/null || true
  fi
  exit "$status"
}

if [ -z "$work" ]; then
  work=$(mktemp -d)
  made_work=1
elif [ ! -d "$work" ]; then
  mkdir -p "$work"
  made_work=1
fi
# absolute, as zpool status -P prints the vdev
work=$(cd "$work" && pwd)
mnt=$work/mnt
img=$work/pool.img
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# mkdir without -p and a noclobber create fail on an existing path, so a
# path that appeared since the checks above is refused, never taken over
mkdir "$mnt"
made_mnt=1
(set -o noclobber && : >"$img")
made_img=1
truncate -s "${gib}G" "$img"
# the properties deploy/bootstrap.sh gives the imp root dataset
zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa \
  "$pool" "$img"
zfs create -o mountpoint=legacy "$pool/imp"
mount -t zfs "$pool/imp" "$mnt"

# in the background, so a TERM or INT reaches the trap at once and cleanup
# stops the run before it releases the pool
cd "$repo"
IMP_TEST_ZFS_ROOT=$pool/imp IMP_TEST_ZFS_DIR=$mnt bun test packages/daemon/src/storage/zfs &
child=$!
wait "$child"
child=
