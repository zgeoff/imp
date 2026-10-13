#!/usr/bin/env bash
# Build the imp guest kernel (uncompressed vmlinux for Firecracker x86_64).
#
#   kernel/build.sh              -> kernel/out/vmlinux, kernel/out/config
#   kernel/build.sh --fetch      only download, check and unpack the source
#   kernel/build.sh --in-builder build inside the kernel-builder stage itself
#
# The build runs as the calling user in the kernel-builder stage of
# host/Dockerfile, the same pinned toolchain the host image build uses; that
# build's kernel stage runs this script too, with --fetch then --in-builder.
# Sources and the object tree stay in kernel/.build, so a rerun is incremental.
set -euo pipefail

mode=${1:-}
case "$mode" in
  '' | --fetch | --in-builder) ;;
  *)
    echo "usage: kernel/build.sh [--fetch | --in-builder]" >&2
    exit 2
    ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
# KVER and KSHA256 from the environment win over kernel/version.
env_kver=${KVER:-}
env_ksha256=${KSHA256:-}
# shellcheck source=kernel/version
source "$here/version"
KVER=${env_kver:-$KVER}
KSHA256=${env_ksha256:-$KSHA256}
JOBS="${JOBS:-$(nproc)}"
BUILDER_IMAGE="imp-kernel-builder:dev"

build="$here/.build"
out="$here/out"
mkdir -p "$build" "$out"

# An unpacked tree came from a checked tarball, so it needs neither again;
# the image build drops the tarball once the tree is out.
src="$build/linux-$KVER"
if [[ ! -d "$src" ]]; then
  tarball="$build/linux-$KVER.tar.xz"
  if [[ ! -f "$tarball" ]]; then
    curl -fL --retry 3 -o "$tarball.part" \
      "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KVER.tar.xz"
    mv "$tarball.part" "$tarball"
  fi
  echo "$KSHA256  $tarball" | sha256sum -c -
  # unpack beside the tree, so an interrupted tar never leaves a partial one
  rm -rf "$build/unpack"
  mkdir "$build/unpack"
  tar -C "$build/unpack" -xf "$tarball"
  mv "$build/unpack/linux-$KVER" "$src"
  rmdir "$build/unpack"
fi

case "$mode" in
  --fetch) exit 0 ;;
  --in-builder)
    JOBS="$JOBS" "$here/make-vmlinux.sh" "$src" "$build/obj" "$out"
    exit 0
    ;;
esac

docker build -q -t "$BUILDER_IMAGE" --target kernel-builder \
  -f "$here/../host/Dockerfile" "$here/.." >/dev/null

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$here:/k" \
  -e JOBS="$JOBS" \
  "$BUILDER_IMAGE" /k/make-vmlinux.sh "/k/.build/linux-$KVER" /k/.build/obj /k/out

ls -l "$out/vmlinux"
