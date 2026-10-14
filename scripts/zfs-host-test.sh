#!/bin/bash
# The ZFS storage backend on a real host, in two parts:
#
#   1. scripts/test-zfs.sh: the backend's tests against a throwaway pool.
#   2. A dev instance on a second throwaway pool runs e2e suites (default
#      checkpoints and sleep). impd's log lines and the suites' metrics then
#      time impd on ZFS: checkpoint, restore, fork, sleep.
#
#   scripts/zfs-host-test.sh
#
# Both pools live in sparse files under IMP_ZFS_TEST_DIR (default a new dir
# in /var/tmp); no disk is touched, and both pools go when it ends. Run it as
# a user with sudo and docker, on a host with KVM and the zfs module loaded
# (sudo modprobe zfs). The module must be OpenZFS 2.x, the host image's
# major version; a minor skew only warns. Needs the guest kernel and system
# drive that scripts/dev/dev.sh needs.
#
# Env: IMP_DEV_PORT_OFFSET (default 300) for the dev instance imp-zfs;
#      IMP_ZFS_BENCH_GIB (default 40) sizes the second pool's file;
#      IMP_ZFS_E2E_SUITES (default checkpoints,sleep) picks the suites (CI adds
#      lifecycle, disks, backups, boot-templates and moves, whose second impd
#      gets a root dataset and a data dir of its own);
#      IMP_ZFS_TEST_UNIT=0 skips part 1 (the zfs CI job runs it on its own).
#      The summary is also written to <dir>/summary.txt.
#      IMP_ZFS_MODULE_VERSION_FILE (default /sys/module/zfs/version) is
#      where the loaded module's version is read, for the script's tests.
#
# The run owns only what it creates: before it touches anything it refuses a
# bench pool name that is taken, a bench.img or a data dir of either impd
# already in the work dir, and an imp-zfs or imp-zfs-mv-b container or an
# imp-zfs-mv network that is already there. Its cleanup releases
# only what it made: it destroys the pool only when `zpool status -P` shows
# its vdev is this run's bench.img, and never removes a bench.img a pool
# still uses. The work dir holds the results, so it stays, and a second run
# in the same dir is refused for its data dir.
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

export IMP_DEV_NAME=imp-zfs

[ -r "$module_version" ] || fail "load the zfs module first (sudo modprobe zfs)"

# a generated or fixed name is not ownership: refuse one that is already in
# use, and a work dir that already holds a bench pool file or a data dir
if sudo zpool list "$pool" >/dev/null 2>&1; then
  fail "a pool named $pool already exists; refusing to touch it"
fi
if [ -e "$work/bench.img" ] || [ -L "$work/bench.img" ]; then
  fail "$work/bench.img already exists; refusing to touch it"
fi
for dir in data data-mv-b; do
  if [ -e "$work/$dir" ] || [ -L "$work/$dir" ]; then
    fail "$work/$dir already exists; refusing to touch it"
  fi
done
for name in "$IMP_DEV_NAME" "$IMP_DEV_NAME-mv-b"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    fail "a container named $name already exists; refusing to touch it"
  fi
done
if docker network inspect "$IMP_DEV_NAME-mv" >/dev/null 2>&1; then
  fail "a network named $IMP_DEV_NAME-mv already exists; refusing to touch it"
fi

mkdir -p "$work"
# absolute, as zpool status -P prints the vdev
work=$(cd "$work" && pwd)
img=$work/bench.img

echo "zfs-host-test: zfs module $(cat "$module_version"); results in $work"

if [ "${IMP_ZFS_TEST_UNIT:-1}" != 0 ]; then
  sudo env "PATH=$PATH" IMP_ZFS_TEST_DIR="$work/unit" "$IMP_ROOT/scripts/test-zfs.sh"
  rmdir "$work/unit" 2>/dev/null || true
fi

export IMP_DEV_PORT_OFFSET=${IMP_DEV_PORT_OFFSET:-300}
export IMP_DEV_DATA=$work/data
export IMP_STORAGE_BACKEND=zfs
export IMP_ZFS_ROOT=$pool/imp

# what this run made, so cleanup releases that and nothing else; the pool is
# proven by its vdev instead, since a signal during its create runs the trap
# only once the create has finished
made_img=
started_instance=

# the e2e run, while it runs, so a signal can stop it first
child=

# img_use [POOL]: 0 when POOL, or any pool, lists this run's file as a vdev,
# 1 when none does, 2 when zpool cannot say; a vdev path may hold spaces
img_use() {
  local pools out
  pools=$(sudo zpool list -H -o name 2>/dev/null) || return 2
  if [ -n "${1:-}" ] && ! grep -qxF -- "$1" <<<"$pools"; then
    return 1
  fi
  out=$(sudo zpool status -P "$@" 2>/dev/null) || return 2
  awk -v img="$img" '{
    sub(/^[ \t]+/, "")
    rest = substr($0, length(img) + 1)
    if (index($0, img) == 1 && (rest == "" || rest ~ /^[ \t]/)) found = 1
  } END { exit !found }' <<<"$out"
}


# DIAGNOSTIC (GEO-832, not for merge): what holds the pool, at time $SECONDS
holders() {
  echo "::group::holders of $pool: $1 at ${SECONDS}s"
  echo "-- host-ns mounted datasets"
  sudo zfs list -H -r -o name,mounted "$pool" 2>&1 | awk '$2 != "no"' || true
  echo "-- processes whose mount ns holds a dataset of $pool"
  local f pid seen=""
  for f in /proc/[0-9]*/mountinfo; do
    pid=${f#/proc/}
    pid=${pid%/mountinfo}
    n=$(sudo grep -cE " - zfs $pool(/| )" "$f" 2>/dev/null) || n=0
    [ "$n" -gt 0 ] || continue
    ns=$(sudo readlink "/proc/$pid/ns/mnt" 2>/dev/null)
    echo "pid=$pid ns=$ns mounts=$n $(ps -o ppid=,stat=,etimes=,args= -p "$pid" 2>/dev/null | cut -c1-200)"
    case " $seen " in *" $ns "*) ;; *) seen="$seen $ns"; sudo grep -E " - zfs $pool(/| )" "$f" | head -20 ;; esac
  done
  echo "-- containers"
  docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' || true
  echo "-- firecracker/jailer/impd/zfs processes"
  ps -eo pid,ppid,stat,etimes,args | grep -E 'firecracker|jailer|impd|zfs |zpool |restic|containerd-shim' | grep -v grep | cut -c1-200 || true
  echo "-- spa"
  sudo cat "/proc/spl/kstat/zfs/$pool/state" 2>/dev/null || true
  sudo cat /proc/spl/kstat/zfs/dbgmsg 2>/dev/null | tail -30 || true
  echo "::endgroup::"
}

# In reverse order; the results stay in $work. A pool that will not go keeps
# its file, so it can still be imported and destroyed by hand, and the run
# fails.
cleanup() {
  local status=$?
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  if [ -n "$started_instance" ]; then
    # the moves suites' B with its docker proxy and volumes, which a stopped
    # run leaves up with B's dataset busy in the pool, then A and the network
    # both were on
    if docker container inspect "$IMP_DEV_NAME-mv-b" >/dev/null 2>&1; then
      docker logs "$IMP_DEV_NAME-mv-b" >"$work/impd-mv-b.log" 2>&1 || true
      IMP_DEV_NAME=$IMP_DEV_NAME-mv-b IMP_DEV_DATA=$work/data-mv-b \
        "$IMP_ROOT/scripts/dev/dev.sh" down || true
    fi
    docker logs "$IMP_DEV_NAME" >"$work/impd.log" 2>&1 || true
    "$IMP_ROOT/scripts/dev/dev.sh" down || true
    docker network rm "$IMP_DEV_NAME-mv" >/dev/null 2>&1 || true
  fi
  if [ -n "$made_img" ]; then
    local use=0
    img_use "$pool" || use=$?
    holders "after dev.sh down"
    local try
    for try in $(seq 1 60); do
      if sudo zpool destroy -f "$pool"; then
        echo "zfs-host-test DIAG: destroyed $pool on try $try at ${SECONDS}s"
        break
      fi
      [ "$try" != 1 ] || holders "first busy"
      [ $((try % 10)) != 0 ] || holders "try $try"
      sleep 1
    done
    if [ "$use" = 0 ] && sudo zpool list "$pool" >/dev/null 2>&1; then
      echo "zfs-host-test: could not destroy $pool; its file stays at $img" >&2
      [ "$status" != 0 ] || status=1
      exit "$status"
    fi
    # never the file of a pool that is still there, or may be
    use=0
    img_use || use=$?
    if [ "$use" != 1 ]; then
      if [ "$use" = 0 ]; then
        echo "zfs-host-test: a pool still uses $img; it stays" >&2
      else
        echo "zfs-host-test: zpool cannot say which pools use $img; it stays" >&2
      fi
      [ "$status" != 0 ] || status=1
      exit "$status"
    fi
    sudo rm -f "$img"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# mkdir without -p and a noclobber create fail on an existing path, so a
# path that appeared since the checks above is refused, never taken over
mkdir "$work/data"
mkdir "$work/data-mv-b"
(set -o noclobber && : >"$img")
made_img=1
truncate -s "${gib}G" "$img"
# what deploy/bootstrap.sh gives the root dataset; impd sets recordsize=16K
# on the datasets that hold disks
sudo zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa \
  "$pool" "$img"
sudo zfs create -o mountpoint=legacy "$IMP_ZFS_ROOT"
# the moves suites' B, on a root dataset of its own (test/e2e/lib/move-hosts.ts)
sudo zfs create -o mountpoint=legacy "$IMP_ZFS_ROOT-mv-b"

# what test/e2e/main.ts proves before it wipes this run's data dirs and
# datasets to make an instance anew, one owner file for each impd
printf '{"pool":"%s","root":"%s","vdev":"%s"}\n' "$pool" "$IMP_ZFS_ROOT" "$img" \
  >"$work/data/imp-e2e-zfs-owner"
printf '{"pool":"%s","root":"%s","vdev":"%s"}\n' "$pool" "$IMP_ZFS_ROOT-mv-b" "$img" \
  >"$work/data-mv-b/imp-e2e-zfs-owner"

# summarize LABEL REGEX: count, min, median and max of the ms in each match
summarize() {
  { grep -oE "$2" "$work/impd.log" || true; } | grep -oE '[0-9]+ms$' | tr -d ms | sort -n |
    awk -v label="$1" '{ v[NR] = $1 } END {
      if (NR == 0) { printf "%-22s no samples\n", label; exit }
      printf "%-22s n=%d  min %d  median %d  max %d ms\n", label, NR, v[1], v[int((NR + 1) / 2)], v[NR]
    }'
}

report() {
  echo "zfs-host-test: impd timings on ZFS"
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

# In the background, so a TERM or INT reaches the trap at once and cleanup
# stops the run before it stops the instance; its output goes through tee,
# whose own exit is awaited so the log is whole before the report reads it.
# A failed suite still gets its report; the script then exits with the
# suites' status.
started_instance=1
exec 3> >(tee "$work/e2e.log")
tee_pid=$!
"$IMP_ROOT/test/test-e2e.sh" --only "${IMP_ZFS_E2E_SUITES:-checkpoints,sleep}" >&3 2>&1 &
child=$!
set +e
wait "$child"
status=$?
set -e
child=
exec 3>&-
wait "$tee_pid" || true

docker logs "$IMP_DEV_NAME" >"$work/impd.log" 2>&1 || true

echo
report | tee "$work/summary.txt" || true
[ "$status" = 0 ] || exit "$status"
