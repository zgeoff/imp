#!/bin/bash
# Make /var/lib/imp an XFS filesystem with reflink, then create the layout
# from docs/architecture/storage.md ("The data directory"). Idempotent. On
# bare metal, mount a real XFS partition at /var/lib/imp first and this only
# creates the directories.
#
# Env: IMP_STORAGE_GIB (default 200) sizes the sparse loop file.
#      IMP_STORAGE_FILE (default /data/imp.xfs) is where it lives.
set -euo pipefail

root=/var/lib/imp
file=${IMP_STORAGE_FILE:-/data/imp.xfs}
gib=${IMP_STORAGE_GIB:-200}

# Something already mounted here (bare metal, or a second run) is used as
# is; mounting the image on top would hide it. Either way, the check below
# decides whether the result can reflink.
mounted=
if mountpoint -q "$root"; then
  echo "setup-storage: $root already mounted"
else
  mkdir -p "$root" "$(dirname "$file")"
  if [ ! -e "$file" ]; then
    echo "setup-storage: creating ${gib} GiB sparse $file"
    truncate -s "${gib}G" "$file"
    # The WSL 6.6 kernel rejects newer xfsprogs defaults (nrext64, exchange,
    # parent pointers); these flags keep the fs mountable there.
    mkfs.xfs -q -m reflink=1 -i nrext64=0,exchange=0 -n parent=0 "$file"
  fi
  mount -o loop "$file" "$root"
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
