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
#      lifecycle, disks, backups and boot-templates);
#      IMP_ZFS_TEST_UNIT=0 skips part 1 (the zfs CI job runs it on its own).
#      The summary is also written to <dir>/summary.txt.
#      IMP_ZFS_MODULE_VERSION_FILE (default /sys/module/zfs/version) is
#      where the loaded module's version is read, for the script's tests.
#
# The run owns only what it creates: it refuses a bench pool name that is
# taken, or a bench.img already in the work dir, before it touches anything,
# and its cleanup releases only what it made. The work dir holds the results,
# so it stays.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

fail() {
  echo "zfs-host-test: $1" >&2
  exit 1
}

work=${IMP_ZFS_TEST_DIR:-$(mktemp -d /var/tmp/imp-zfs.XXXXXX)}
pool=impbench$$
gib=${IMP_ZFS_BENCH_GIB:-40}
module_version=${IMP_ZFS_MODULE_VERSION_FILE:-/sys/module/zfs/version}

[ -r "$module_version" ] || fail "load the zfs module first (sudo modprobe zfs)"

# a generated name is not ownership: refuse one that is already in use, and
# a work dir that already holds a bench pool file
if sudo zpool list "$pool" >/dev/null 2>&1; then
  fail "a pool named $pool already exists; refusing to touch it"
fi
if [ -e "$work/bench.img" ] || [ -L "$work/bench.img" ]; then
  fail "$work/bench.img already exists; refusing to touch it"
fi

echo "zfs-host-test: zfs module $(cat "$module_version"); results in $work"

if [ "${IMP_ZFS_TEST_UNIT:-1}" != 0 ]; then
  sudo env "PATH=$PATH" IMP_ZFS_TEST_DIR="$work/unit" "$IMP_ROOT/scripts/test-zfs.sh"
  rmdir "$work/unit" 2>/dev/null || true
fi

export IMP_DEV_NAME=imp-zfs
export IMP_DEV_PORT_OFFSET=${IMP_DEV_PORT_OFFSET:-300}
export IMP_DEV_DATA=$work/data
export IMP_STORAGE_BACKEND=zfs
export IMP_ZFS_ROOT=$pool/imp

# what this run made, so cleanup releases that and nothing else
made_img=
made_pool=
started_instance=

# In reverse order; the results stay in $work. A pool that will not go keeps
# its file, so it can still be imported and destroyed by hand, and the run
# fails.
cleanup() {
  local status=$?
  if [ -n "$started_instance" ]; then
    docker logs "$IMP_DEV_NAME" >"$work/impd.log" 2>&1 || true
    "$IMP_ROOT/scripts/dev.sh" down || true
  fi
  if [ -n "$made_pool" ] && ! sudo zpool destroy -f "$pool"; then
    echo "zfs-host-test: could not destroy $pool; its file stays at $work/bench.img" >&2
    [ "$status" != 0 ] || status=1
    exit "$status"
  fi
  if [ -n "$made_img" ]; then
    sudo rm -f "$work/bench.img"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# a noclobber create fails on an existing path, so a file that appeared
# since the check above is refused, never taken over
(set -o noclobber && : >"$work/bench.img")
made_img=1
truncate -s "${gib}G" "$work/bench.img"
# what deploy/bootstrap.sh gives the root dataset; impd sets recordsize=16K
# on the datasets that hold disks
sudo zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa \
  "$pool" "$work/bench.img"
made_pool=1
sudo zfs create -o mountpoint=legacy "$IMP_ZFS_ROOT"

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
  sudo zfs list -r -o name,used,refer,compressratio,recordsize "$pool"
}

# A failed suite still gets its report; the script then exits with the
# suites' status.
set +e
started_instance=1
"$IMP_ROOT/scripts/test-e2e.sh" --only "${IMP_ZFS_E2E_SUITES:-checkpoints,sleep}" 2>&1 |
  tee "$work/e2e.log"
status=${PIPESTATUS[0]}
set -e

docker logs "$IMP_DEV_NAME" >"$work/impd.log" 2>&1 || true

echo
report | tee "$work/summary.txt" || true
[ "$status" = 0 ] || exit "$status"
