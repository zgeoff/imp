#!/bin/bash
# Check that the guest kernel and the system drive rebuild to the same bytes.
# A memory snapshot only restores with the kernel and drive it was taken on,
# so an upgrade whose kernel and agent did not change must keep both hashes.
# Only these two files are reproducible; the host image digest is not.
#
#   host/check-reproducible.sh
#
# Builds the system-files stage of host/Dockerfile three times and compares
# the sha256 of vmlinux and imp-system.squashfs:
#   1. with the default builder, from scratch (--no-cache)
#   2. with a fresh builder of its own (no layer cache, no Go cache mount),
#      minutes later, with half the build jobs
#   3. with the default builder's cache, from a copy of the tree with an
#      edit under packages/, which no system-files stage reads
# Two cold kernel builds: expect 5 to 20 minutes.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
builder=imp-reproducible-$$
trap 'docker buildx rm "$builder" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

# build NAME CONTEXT [buildx args...]
build() {
  local name=$1 context=$2
  shift 2
  echo "check-reproducible: building $name" >&2
  docker buildx build -q -f "$context/host/Dockerfile" --target system-files \
    --output "type=local,dest=$work/$name" "$@" "$context" >/dev/null
  (cd "$work/$name" && sha256sum vmlinux imp-system.squashfs) >"$work/$name.sha256"
}

build first "$root" --no-cache

docker buildx create --name "$builder" --driver docker-container >/dev/null
jobs=$(($(nproc) / 2))
build fresh-builder "$root" --builder "$builder" --build-arg JOBS=$((jobs > 0 ? jobs : 1))

# The tree as git sees it (tracked and untracked, not ignored), with a change
# to a file the kernel and drive must not depend on.
copy="$work/tree"
mkdir "$copy"
(cd "$root" && git ls-files -z --cached --others --exclude-standard |
  tar --null -T - -cf -) | tar -xf - -C "$copy"
echo "// check-reproducible $(date +%s%N)" >>"$copy/packages/daemon/src/main.ts"
build packages-changed "$copy"

status=0
for run in fresh-builder packages-changed; do
  if ! diff -u "$work/first.sha256" "$work/$run.sha256"; then
    echo "check-reproducible: the $run build differs from the first" >&2
    status=1
  fi
done
cat "$work/first.sha256"
if [ "$status" = 0 ]; then
  echo "check-reproducible: ok"
fi
exit "$status"
