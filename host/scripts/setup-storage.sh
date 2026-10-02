#!/bin/bash
# Make /var/lib/imp the storage impd expects, then create the layout from
# docs/architecture/storage.md#the-data-directory. Idempotent.
#
# XFS (the default): an XFS filesystem with reflink. On bare metal, mount a
# real XFS partition at /var/lib/imp first and this only creates the
# directories.
# ZFS: the dataset IMP_ZFS_ROOT, mountpoint=legacy, mounted here inside the
# container; impd mounts its children. The pool and dataset come from the
# host (deploy/bootstrap.sh); /dev/zfs needs the module loaded before the
# container starts.
#
# Env: IMP_STORAGE_BACKEND (default xfs) is xfs or zfs; IMP_ZFS_ROOT names
#      the dataset for zfs.
#      IMP_STORAGE_LOOP (default 1): 1 creates and mounts a loop file when
#      nothing is mounted at /var/lib/imp; 0 (the release image) refuses to
#      start without a mount instead. XFS only.
#      IMP_STORAGE_GIB (default 200) sizes the sparse loop file.
#      IMP_STORAGE_FILE (default /data/imp.xfs) is where it lives.
set -euo pipefail

root=/var/lib/imp
backend=${IMP_STORAGE_BACKEND:-xfs}
loop=${IMP_STORAGE_LOOP:-1}
file=${IMP_STORAGE_FILE:-/data/imp.xfs}
gib=${IMP_STORAGE_GIB:-200}

die() {
  echo "setup-storage: $1" >&2
  exit 1
}

# The dataset goes over whatever is here (an empty bind of the host's
# /var/lib/imp, say); a second run finds it on top already.
setup_zfs() {
  local dataset=${IMP_ZFS_ROOT:-}
  [ -n "$dataset" ] || die "IMP_STORAGE_BACKEND=zfs needs IMP_ZFS_ROOT, the dataset for $root"
  [ -c /dev/zfs ] || die "no /dev/zfs; load the zfs module on the host before the container starts"
  local mountpoint
  mountpoint=$(zfs get -H -o value mountpoint "$dataset") ||
    die "no dataset $dataset; deploy/bootstrap.sh creates it"
  [ "$mountpoint" = legacy ] ||
    die "$dataset has mountpoint=$mountpoint; impd mounts it itself: zfs set mountpoint=legacy $dataset"

  local top
  top=$(findmnt -n -r -o SOURCE,FSTYPE --mountpoint "$root" | tail -n 1 || true)
  if [ "$top" = "$dataset zfs" ]; then
    echo "setup-storage: $dataset already mounted on $root"
  else
    mkdir -p "$root"
    mount -t zfs "$dataset" "$root"
    echo "setup-storage: mounted $dataset on $root"
  fi
  mkdir -p "$root"/{db,system,images,imps}
}

if [ "$backend" = zfs ]; then
  setup_zfs
  exit 0
fi
[ "$backend" = xfs ] || die "IMP_STORAGE_BACKEND is $backend; use xfs or zfs"

# make_loop_nodes makes a node for each loop device the kernel has, as
# --privileged would show them (the container may open b 7:*).
make_loop_nodes() {
  local dev n
  for dev in /sys/block/loop*; do
    [ -e "$dev" ] || continue
    n=${dev##*/loop}
    [ -b "/dev/loop$n" ] || mknod "/dev/loop$n" b 7 "$n"
  done
}

# mount_loop FILE DIR mounts FILE through a free loop device. Without
# --privileged the container's /dev has no loop nodes: loop-control finds a
# free number and the node is made here (the container may open every loop
# device, b 7:*). Another container can take the same number between the two,
# so a busy one is tried again.
mount_loop() {
  local file=$1 dir=$2 dev _
  for _ in 1 2 3 4 5; do
    # losetup -f prints "/dev/loopN (lost)" while the node is missing
    dev=$(losetup -f) || die "no free loop device; is /dev/loop-control passed in?"
    dev=${dev%% *}
    [ -b "$dev" ] || mknod "$dev" b 7 "${dev#/dev/loop}"
    if losetup "$dev" "$file" 2>/dev/null; then
      if ! mount "$dev" "$dir"; then
        losetup -d "$dev" || true
        die "cannot mount $dev ($file) on $dir"
      fi
      # Detaching a mounted loop device only marks it: the kernel frees it
      # at umount, as mount -o loop does.
      losetup -d "$dev"
      return
    fi
  done
  die "no loop device for $file after 5 tries"
}

# Something already mounted here (bare metal, or a second run) is used as
# is; mounting the image on top would hide it. Either way, the check below
# decides whether the result can reflink.
mounted=
if mountpoint -q "$root"; then
  echo "setup-storage: $root already mounted"
elif [ "$loop" = 0 ]; then
  echo "setup-storage: nothing is mounted at $root; mount a host XFS directory with reflink there" >&2
  exit 1
else
  # A loop file in the container's own layer goes away with the container,
  # and every imp with it.
  if ! mountpoint -q "$(dirname "$file")"; then
    echo "setup-storage: $(dirname "$file") is not a mount; mount a host directory there for $file" >&2
    exit 1
  fi
  mkdir -p "$root"
  if [ ! -e "$file" ]; then
    echo "setup-storage: creating ${gib} GiB sparse $file"
    truncate -s "${gib}G" "$file"
    # The WSL 6.6 kernel rejects newer xfsprogs defaults (nrext64, exchange,
    # parent pointers); these flags keep the fs mountable there.
    mkfs.xfs -q -m reflink=1 -i nrext64=0,exchange=0 -n parent=0 "$file"
  fi
  # A killed container can leave its loop device attached for a while; a
  # second mount of the same file would let two kernels write one XFS.
  # losetup -j matches by inode only through a device node; without one it
  # matches by path, and another container's /data/imp.xfs has this path.
  make_loop_nodes
  attached=$(losetup -j "$file" -n -O NAME)
  if [ -n "$attached" ]; then
    echo "setup-storage: $file is still attached to $attached; wait for it to detach, or losetup -d it once nothing uses it" >&2
    exit 1
  fi
  mount_loop "$file" "$root"
  mounted=$file
  echo "setup-storage: mounted $file on $root"
fi

# fail prints why $root is unusable, undoes our own mount, and exits.
fail() {
  echo "setup-storage: $1" >&2
  if [ -n "$mounted" ]; then
    umount "$root" || true
  fi
  exit 1
}

fstype=$(findmnt -n -o FSTYPE --mountpoint "$root")
if [ "$fstype" != xfs ]; then
  fail "$root is $fstype${mounted:+ (from $mounted)}; imp needs XFS with reflink"
fi
# Not xfs_info | grep -q: under pipefail, grep exiting early can fail the pipe.
if [[ $(xfs_info "$root") != *reflink=1* ]]; then
  fail "$root is XFS without reflink${mounted:+ (from $mounted)}; recreate it with mkfs.xfs -m reflink=1"
fi

mkdir -p "$root"/{db,system,images,imps}
