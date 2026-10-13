# shellcheck shell=bash
# The storage phase: an XFS with reflink on /var/lib/imp, or a ZFS dataset.

# Storage backends: xfs now; ZFS (#11) adds storage_zfs and a flag.
ensure_storage() {
  phase storage
  case $storage in
    xfs) storage_xfs ;;
    zfs) storage_zfs ;;
  esac
}

storage_xfs() {
  if mountpoint -q "$DATA_DIR"; then
    check_xfs_reflink
    grep -qE "[[:space:]]${DATA_DIR}[[:space:]]" /etc/fstab ||
      warn "$DATA_DIR is mounted but not in /etc/fstab; it will not come back after a reboot"
    findmnt -n -o OPTIONS --mountpoint "$DATA_DIR" | tr ',' '\n' | grep -qx nosuid ||
      warn "$DATA_DIR is mounted without nosuid; add nosuid to its /etc/fstab entry and run: mount -o remount,nosuid $DATA_DIR"
  else
    local source
    if [ -n "$data_device" ]; then
      prepare_device "$data_device"
      source=$(device_source "$data_device")
      ensure_fstab "$(fstab_line "$source" device)"
    else
      prepare_loop_file
      ensure_fstab "$(fstab_line "$loop_file" loop)"
    fi
    change "mount $DATA_DIR" mount_data
    dry || check_xfs_reflink
  fi
  local dir
  for dir in db system images imps; do
    [ -d "$DATA_DIR/$dir" ] || change "mkdir $DATA_DIR/$dir" mkdir -p "$DATA_DIR/$dir"
  done
}

mount_data() {
  mkdir -p "$DATA_DIR"
  systemctl daemon-reload
  mount "$DATA_DIR"
}

check_xfs_reflink() {
  [ "$(findmnt -n -o FSTYPE --mountpoint "$DATA_DIR")" = xfs ] ||
    die "$DATA_DIR is mounted but not XFS; imp needs XFS with reflink"
  [[ $(xfs_info "$DATA_DIR") == *reflink=1* ]] ||
    die "$DATA_DIR is XFS without reflink; recreate it with mkfs.xfs -m reflink=1"
  log "$DATA_DIR is XFS with reflink"
}

# device_source DEV: UUID=… once DEV has a filesystem; the device path in a
# dry run, before mkfs.
device_source() {
  local uuid
  uuid=$(blkid -s UUID -o value "$1" 2>/dev/null || true)
  if [ -n "$uuid" ]; then echo "UUID=$uuid"; else echo "$1"; fi
}

# check_device_free DEV: refuse a device that may hold data in use.
check_device_free() {
  local dev=$1
  # stat, not test -b, so a test can stand in for the device; LC_ALL=C keeps
  # the file type in English whatever the host's locale
  [ "$(LC_ALL=C stat -L -c %F "$dev" 2>/dev/null)" = "block special file" ] || die "$dev is not a block device"
  dev=$(readlink -f "$dev")
  local root_disk
  root_disk=$(findmnt -n -o SOURCE / | sed 's/\[.*//')
  if lsblk -n -s -o PATH "$root_disk" 2>/dev/null | grep -qx "$dev"; then
    die "$dev holds the root filesystem"
  fi
  if [ -n "$(lsblk -n -o MOUNTPOINTS "$dev" | tr -d '[:space:]')" ]; then
    die "$dev or a partition on it is mounted"
  fi
  if [ "$(lsblk -n -o PATH "$dev" | wc -l)" -gt 1 ]; then
    die "$dev has partitions or holders (RAID, LVM); give an empty disk or partition"
  fi
}

# prepare_device DEV: refuse anything that may hold data, then mkfs it. A
# device that already holds an XFS with reflink is reused (a second run).
prepare_device() {
  local dev=$1
  check_device_free "$dev"
  local fstype
  fstype=$(blkid -p -s TYPE -o value "$dev" 2>/dev/null || true)
  case $fstype in
    xfs) log "$dev already holds XFS; reusing it" ;;
    "")
      if blkid -p "$dev" >/dev/null 2>&1; then
        die "$dev carries a signature (a partition table?); wipe it by hand if it is free"
      fi
      # shellcheck disable=SC2046 # the options are words
      change "mkfs.xfs $dev" mkfs.xfs -q $(mkfs_xfs_opts "$(uname -r)" "$(xfsprogs_version)") "$dev"
      ;;
    *) die "$dev holds $fstype; give an empty disk or partition" ;;
  esac
}

# storage_zfs: the pool (created on --data-device, imported, or already
# there) and the dataset imp mounts, with mountpoint=legacy. The host never
# mounts it: the container mounts it on /var/lib/imp, and impd creates the
# children (docs/architecture/storage/storage.md#zfs).
storage_zfs() {
  if command -v zpool >/dev/null && zpool list -H -o name "$zfs_pool" >/dev/null 2>&1; then
    log "pool $zfs_pool is imported"
  elif [ -n "$data_device" ]; then
    check_device_free "$data_device"
    local fstype
    fstype=$(blkid -p -s TYPE -o value "$data_device" 2>/dev/null || true)
    case $fstype in
      zfs_member)
        [ "$(blkid -p -s LABEL -o value "$data_device")" = "$zfs_pool" ] ||
          die "$data_device belongs to another ZFS pool"
        change "zpool import $zfs_pool" zpool import "$zfs_pool"
        ;;
      "")
        if blkid -p "$data_device" >/dev/null 2>&1; then
          die "$data_device carries a signature (a partition table?); wipe it by hand if it is free"
        fi
        change "zpool create $zfs_pool on $data_device" zpool create -o ashift=12 \
          -O compression=lz4 -O atime=off -O xattr=sa -O mountpoint=none "$zfs_pool" "$data_device"
        ;;
      *) die "$data_device holds $fstype; give an empty disk or partition" ;;
    esac
  else
    die "no pool $zfs_pool; give --data-device DEV to create it"
  fi

  if ! command -v zfs >/dev/null || ! zfs list -H -o name "$zfs_root" >/dev/null 2>&1; then
    change "zfs create $zfs_root (mountpoint=legacy)" zfs create -o mountpoint=legacy "$zfs_root"
  elif [ "$(zfs get -H -o value mountpoint "$zfs_root")" != legacy ]; then
    change "zfs set mountpoint=legacy $zfs_root" zfs set mountpoint=legacy "$zfs_root"
  else
    log "dataset $zfs_root is there, mountpoint=legacy"
  fi
  [ -d "$DATA_DIR" ] || change "mkdir $DATA_DIR" mkdir -p "$DATA_DIR"
}

prepare_loop_file() {
  local dir avail_gib
  dir=$(dirname "$loop_file")
  [ "$(findmnt -n -o TARGET --target "$dir")" = / ] ||
    die "--loop-file must be on the root filesystem, which mounts before $DATA_DIR"
  if [ -e "$loop_file" ]; then
    [ "$(blkid -p -s TYPE -o value "$loop_file" 2>/dev/null || true)" = xfs ] ||
      die "$loop_file exists and is not XFS"
    log "$loop_file already holds XFS; reusing it"
    return
  fi
  avail_gib=$(($(df --output=avail -k / | tail -n 1) / 1024 / 1024))
  if [ "$loop_size_gib" = auto ]; then
    loop_size_gib=$(loop_size_auto_gib "$avail_gib")
    log "${avail_gib} GiB free on /; the loop file gets ${loop_size_gib} GiB"
  elif [ $((avail_gib - loop_size_gib)) -lt "$(loop_reserve_gib "$avail_gib")" ]; then
    warn "$loop_file is sparse: once full, ${loop_size_gib} GiB leaves under $(loop_reserve_gib "$avail_gib") GiB of the ${avail_gib} GiB free on / for the OS"
  fi
  [ "$loop_size_gib" -ge "$LOOP_MIN_GIB" ] ||
    die "a ${loop_size_gib} GiB loop file is too small (${avail_gib} GiB free on /); imp needs ${LOOP_MIN_GIB}"
  change "create a ${loop_size_gib} GiB sparse XFS file $loop_file" make_loop_file
}

make_loop_file() {
  mkdir -p "$(dirname "$loop_file")"
  truncate -s "${loop_size_gib}G" "$loop_file"
  # shellcheck disable=SC2046 # the options are words
  mkfs.xfs -q $(mkfs_xfs_opts "$(uname -r)" "$(xfsprogs_version)") "$loop_file"
}

xfsprogs_version() {
  if command -v mkfs.xfs >/dev/null; then
    mkfs.xfs -V | grep -oE '[0-9]+(\.[0-9]+)+'
  else
    echo 0 # a dry run before the package is installed
  fi
}

# mkfs_xfs_opts KERNEL XFSPROGS: the mkfs.xfs options for an XFS this kernel
# can mount. Each feature is turned off only when xfsprogs knows the option
# (an older mkfs.xfs rejects it) and the kernel cannot mount it.
mkfs_xfs_opts() {
  local kernel=$1 progs=$2 inode=()
  local opts=(-m reflink=1)
  if version_ge "$progs" 5.19 && ! version_ge "$kernel" 5.19; then
    inode+=(nrext64=0)
  fi
  if version_ge "$progs" 6.13 && ! version_ge "$kernel" 6.10; then
    inode+=(exchange=0)
  fi
  if [ ${#inode[@]} -gt 0 ]; then
    opts+=(-i "$(
      IFS=,
      echo "${inode[*]}"
    )")
  fi
  if version_ge "$progs" 6.13 && ! version_ge "$kernel" 6.12; then
    opts+=(-n parent=0)
  fi
  echo "${opts[*]}"
}

# loop_size_auto_gib AVAIL_GIB: the loop file's size from the free space on
# /. The OS, Docker's images and logs keep the larger of 30 GiB and 15 %;
# the file is sparse, but it must never grow into that and fill /.
loop_size_auto_gib() { echo $(($1 - $(loop_reserve_gib "$1"))); }

# loop_reserve_gib AVAIL_GIB: what / keeps for the OS when a loop file is
# on it.
loop_reserve_gib() {
  local keep=$(($1 * 15 / 100))
  [ "$keep" -lt 30 ] && keep=30
  echo "$keep"
}

# ensure_fstab LINE [FSTAB]: FSTAB (default /etc/fstab) holds LINE for
# $DATA_DIR, and no other entry for it.
ensure_fstab() {
  local line=$1 fstab=${2:-/etc/fstab}
  case $(fstab_entry_state "$fstab" "$line") in
    none) change "add $DATA_DIR to $fstab" append_line "$fstab" "$line" ;;
    same) ;;
    old) warn "$DATA_DIR in $fstab lacks nosuid; add it to the entry, then run: mount -o remount,nosuid $DATA_DIR" ;;
    other) die "$fstab has another entry for $DATA_DIR; fix or remove it first" ;;
  esac
}

# fstab_line SOURCE KIND: the /etc/fstab entry for /var/lib/imp. nofail: a
# missing disk must not stop the boot; the host container then refuses to
# start, because nothing is mounted. nosuid: the host never honors a setuid
# bit or a file capability from an image's files.
fstab_line() {
  case $2 in
    device) printf '%s %s xfs defaults,nosuid,nofail 0 2\n' "$1" "$DATA_DIR" ;;
    loop) printf '%s %s xfs loop,nosuid,nofail 0 0\n' "$1" "$DATA_DIR" ;;
  esac
}

# fstab_entry_state FSTAB LINE: none when FSTAB has no entry for
# /var/lib/imp, same when it has LINE, old when it has LINE as a bootstrap
# before nosuid wrote it, other for anything else.
fstab_entry_state() {
  if ! grep -qE "^[^#]*[[:space:]]${DATA_DIR}[[:space:]]" "$1"; then
    echo none
  elif grep -qxF "$2" "$1"; then
    echo same
  elif grep -qxF "${2/,nosuid/}" "$1"; then
    echo old
  else
    echo other
  fi
}

append_line() { printf '%s\n' "$2" >>"$1"; }
