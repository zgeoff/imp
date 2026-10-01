#!/bin/bash
# Turn an OCI image into a sparse ext4 rootfs for an imp (DESIGN.md 2.5).
#
#   build-rootfs.sh <image-ref> <out.ext4> [size, default 32G]
#
# The OCI config (Env, WorkingDir, User) is written to /etc/imp/image.json.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

if [ $# -lt 2 ]; then
  echo "usage: $0 <image-ref> <out.ext4> [size]" >&2
  exit 2
fi
ref=$1
out=$(realpath -m "$2")
size=${3:-32G}

ensure_host_image
mkdir -p "$(dirname "$out")"
cid=$(docker create "$ref" /bin/true)
trap 'docker rm -f "$cid" >/dev/null' EXIT
config=$(docker image inspect "$ref" --format '{{json .Config}}')

# Unpack as root with numeric ids so ownership survives, then let
# mkfs.ext4 -d copy the tree into the image.
docker export "$cid" | docker run --rm -i \
  -e CONFIG="$config" -e SIZE="$size" -e OWNER="$(id -u):$(id -g)" \
  -v "$(dirname "$out"):/out" "$IMP_HOST_IMAGE" sh -euc '
  root=$(mktemp -d) && chmod 755 "$root"
  tar --numeric-owner --xattrs -xpf - -C "$root"
  mkdir -p "$root/etc/imp"
  printf "%s" "$CONFIG" | jq "{env: (.Env // []), workdir: (.WorkingDir // \"\"), user: (.User // \"\")}" \
    > "$root/etc/imp/image.json"
  img=/out/'"$(basename "$out")"'
  rm -f "$img"
  truncate -s "$SIZE" "$img"
  mkfs.ext4 -q -F -L imp-root -d "$root" "$img"
  chown "$OWNER" "$img"
'
echo "$out"
