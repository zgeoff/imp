#!/bin/bash
# A cgroup per imp for CPU and memory limits (docs/architecture/daemon.md#cgroups).
# Only in a private cgroup v2 namespace, where /sys/fs/cgroup is this
# container's own subtree; anywhere else impd stores limits without enforcing
# them. Never fails the container: CPU limits are not worth an outage.
set -uo pipefail

root=/sys/fs/cgroup

if [ "$(cat /proc/self/cgroup)" != "0::/" ]; then
  echo "setup-cgroups: not in a private cgroup v2 namespace; CPU and memory limits are off" >&2
  exit 0
fi

# Docker mounts it read-only without --privileged. The namespace is private,
# so the remount reaches no cgroup but this container's own (CAP_SYS_ADMIN).
if [[ ,$(findmnt -n -o OPTIONS --mountpoint "$root"), == *,ro,* ]]; then
  if ! mount -o remount,rw "$root" 2>/dev/null; then
    echo "setup-cgroups: cannot remount $root read-write; CPU and memory limits are off" >&2
    exit 0
  fi
fi

# A cgroup that hands controllers to its children may hold no process, so
# every process here moves to /init first: pid 1 included, which is where
# docker exec then puts its own.
# The list is read whole each pass: cgroup.procs read while pids leave it
# skips some.
mkdir -p "$root/init"
for _ in 1 2 3 4 5; do
  pids=$(cat "$root/cgroup.procs")
  [ -z "$pids" ] && break
  for pid in $pids; do
    echo "$pid" >"$root/init/cgroup.procs" 2>/dev/null || true
  done
done

# one controller at a time, so a missing one leaves the others on
enable() {
  local dir=$1 controller=$2
  if ! grep -qw "$controller" "$dir/cgroup.controllers"; then
    echo "setup-cgroups: no $controller controller in $dir; $controller limits are off" >&2
    return 1
  fi
  if ! echo "+$controller" >"$dir/cgroup.subtree_control" 2>/dev/null; then
    echo "setup-cgroups: cannot enable $controller in $dir; $controller limits are off" >&2
    return 1
  fi
}

enable "$root" cpu || exit 0

# impd makes imps/<id> for each Firecracker, the layout of the jailer's
# --parent-cgroup
mkdir -p "$root/imps"
enable "$root/imps" cpu || exit 0
echo "setup-cgroups: CPU limits on"

# each VM's memory limit; without it the CPU limits still hold
if enable "$root" memory && enable "$root/imps" memory; then
  echo "setup-cgroups: memory limits on"
fi
