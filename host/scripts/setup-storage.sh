#!/bin/bash
# Make /var/lib/imp an XFS filesystem with reflink, then create the layout
# from DESIGN.md 2.4. Idempotent. On bare metal, mount a real XFS partition
# at /var/lib/imp first and this only creates the directories.
#
# Env: IMP_STORAGE_GIB (default 200) sizes the sparse loop file.
#      IMP_STORAGE_FILE (default /data/imp.xfs) is where it lives.
set -euo pipefail

root=/var/lib/imp
file=${IMP_STORAGE_FILE:-/data/imp.xfs}
gib=${IMP_STORAGE_GIB:-200}

if [ "$(findmnt -n -o FSTYPE --target "$root" 2>/dev/null || true)" = xfs ] && mountpoint -q "$root"; then
  echo "setup-storage: $root already on XFS"
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
  echo "setup-storage: mounted $file on $root"
fi

mkdir -p "$root"/{db,system,images,imps}
