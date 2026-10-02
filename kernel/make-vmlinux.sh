#!/usr/bin/env bash
# Configure and build vmlinux from an unpacked kernel tree. Runs inside the
# kernel-builder stage of host/Dockerfile: kernel/build.sh runs it in a
# container for development, and the host image build runs it for a release.
#
#   make-vmlinux.sh SRC OBJ OUT
#
# SRC is the unpacked linux-$KVER tree, OBJ the object tree (kept between
# runs, so a rerun is incremental), OUT gets vmlinux and config. The config
# inputs are config-base and docker.fragment next to this script.
set -euo pipefail

src=$1
obj=$2
out=$3
here="$(cd "$(dirname "$0")" && pwd)"
jobs=${JOBS:-$(nproc)}

# Fixed build metadata: the kernel stamps these into its version banner, and
# a release must rebuild to the same bytes (host/check-reproducible.sh).
export KBUILD_BUILD_TIMESTAMP='1970-01-01 00:00:00 UTC'
export KBUILD_BUILD_USER=imp
export KBUILD_BUILD_HOST=imp
export KBUILD_BUILD_VERSION=1

mkdir -p "$obj" "$out"
cd "$src"
# merge_config.sh -m: merge only; olddefconfig fills new symbols.
KCONFIG_CONFIG="$obj/.config" scripts/kconfig/merge_config.sh -m -O "$obj" \
  "$here/config-base" "$here/docker.fragment"
make O="$obj" olddefconfig
make O="$obj" -j"$jobs" vmlinux
cp "$obj/vmlinux" "$out/vmlinux"
cp "$obj/.config" "$out/config"

# Fail on fragment symbols that olddefconfig dropped (unmet deps or typos).
missing=0
while IFS= read -r line; do
  [[ "$line" =~ ^(CONFIG_[A-Za-z0-9_]+)=(.*)$ ]] || continue
  if ! grep -qx "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}" "$out/config"; then
    echo "make-vmlinux: ${BASH_REMATCH[1]}=${BASH_REMATCH[2]} not in final config" >&2
    missing=1
  fi
done <"$here/docker.fragment"
exit "$missing"
