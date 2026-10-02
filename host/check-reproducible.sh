#!/bin/bash
# Check that the guest kernel and the system drive rebuild to the same bytes.
# A memory snapshot only restores with the kernel and drive it was taken on,
# so an upgrade whose kernel and agent did not change must keep both hashes.
#
#   host/check-reproducible.sh
#
# Builds the system-files stage of host/Dockerfile three times and compares
# the sha256 of vmlinux and imp-system.squashfs:
#   1. from scratch (--no-cache)
#   2. from scratch again, minutes later, with half the build jobs
#   3. from the cache after a change under packages/, which must not touch them
# Two cold kernel builds: expect 20 minutes or more.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
probe="$root/packages/.reproducible-probe"
trap 'rm -rf "$work" "$probe"' EXIT

build() {
  local dest=$1
  shift
  echo "check-reproducible: building $dest" >&2
  docker buildx build -q -f "$root/host/Dockerfile" --target system-files \
    --output "type=local,dest=$work/$dest" "$@" "$root" >/dev/null
  (cd "$work/$dest" && sha256sum vmlinux imp-system.squashfs) >"$work/$dest.sha256"
}

build first --no-cache
build second --no-cache --build-arg JOBS=$(($(nproc) / 2 > 0 ? $(nproc) / 2 : 1))
date +%s%N >"$probe"
build packages-changed

status=0
for run in second packages-changed; do
  if ! diff -u "$work/first.sha256" "$work/$run.sha256"; then
    echo "check-reproducible: the $run build differs from the first" >&2
    status=1
  fi
done
cat "$work/first.sha256"
[ "$status" = 0 ] && echo "check-reproducible: ok"
exit "$status"
