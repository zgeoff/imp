#!/usr/bin/env bash
# Build the imp guest kernel (uncompressed vmlinux for Firecracker x86_64).
#
#   kernel/build.sh            -> kernel/out/vmlinux, kernel/out/config
#
# The build runs in a Docker container as the calling user. Sources and the
# object tree stay in kernel/.build, so a rerun is incremental.
set -euo pipefail

KVER="${KVER:-6.1.188}"
KSHA256="${KSHA256:-ed4d0acb1307c235230c89efc094e210e6290593f94a7e617f28b1001101a33a}"
JOBS="${JOBS:-$(nproc)}"
BUILDER_IMAGE="imp-kernel-builder:22.04"

here="$(cd "$(dirname "$0")" && pwd)"
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

# Ubuntu 22.04 gives gcc 11, the same compiler as Firecracker's CI config.
docker build -q -t "$BUILDER_IMAGE" - >/dev/null <<'EOF'
FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential bc bison flex libelf-dev libssl-dev python3 cpio kmod xz-utils \
    && rm -rf /var/lib/apt/lists/*
EOF

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$here:/k" \
  -w "/k/.build/linux-$KVER" \
  -e KVER="$KVER" -e JOBS="$JOBS" \
  "$BUILDER_IMAGE" bash -euo pipefail -c '
    obj=/k/.build/obj
    mkdir -p "$obj"
    # merge_config.sh -m: merge only; olddefconfig fills new symbols.
    KCONFIG_CONFIG="$obj/.config" scripts/kconfig/merge_config.sh -m -O "$obj" \
      /k/config-base /k/docker.fragment
    make O="$obj" olddefconfig
    make O="$obj" -j"$JOBS" vmlinux
    cp "$obj/vmlinux" /k/out/vmlinux
    cp "$obj/.config" /k/out/config
  '

# Report fragment symbols that olddefconfig dropped (unmet deps or typos).
missing=0
while IFS= read -r line; do
  [[ "$line" =~ ^(CONFIG_[A-Za-z0-9_]+)=(.*)$ ]] || continue
  if ! grep -qx "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}" "$out/config"; then
    echo "warning: ${BASH_REMATCH[1]}=${BASH_REMATCH[2]} not in final config" >&2
    missing=1
  fi
done < "$here/docker.fragment"

ls -l "$out/vmlinux"
exit "$missing"
