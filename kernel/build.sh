#!/usr/bin/env bash
# Build the imp guest kernel (uncompressed vmlinux for Firecracker x86_64).
#
#   kernel/build.sh            -> kernel/out/vmlinux, kernel/out/config
#
# The build runs as the calling user in the kernel-builder stage of
# host/Dockerfile, the same pinned toolchain the host image build uses.
# Sources and the object tree stay in kernel/.build, so a rerun is incremental.
set -euo pipefail

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

tarball="$build/linux-$KVER.tar.xz"
if [[ ! -f "$tarball" ]]; then
  curl -fL --retry 3 -o "$tarball.part" \
    "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KVER.tar.xz"
  mv "$tarball.part" "$tarball"
fi
echo "$KSHA256  $tarball" | sha256sum -c -

src="$build/linux-$KVER"
if [[ ! -d "$src" ]]; then
  tar -C "$build" -xf "$tarball"
fi

docker build -q -t "$BUILDER_IMAGE" --target kernel-builder \
  -f "$here/../host/Dockerfile" "$here/.." >/dev/null

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$here:/k" \
  -e JOBS="$JOBS" \
  "$BUILDER_IMAGE" /k/make-vmlinux.sh "/k/.build/linux-$KVER" /k/.build/obj /k/out

ls -l "$out/vmlinux"
