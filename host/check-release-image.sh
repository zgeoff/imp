#!/bin/bash
# Check a built release image before it is pushed: impd and the CLI in it
# report the expected version, and the guest kernel and the system drive in
# it are the same bytes as the release assets.
#
#   host/check-release-image.sh IMAGE VERSION SHA256SUMS
#
# VERSION is the release version without the v (0.4.0 for tag v0.4.0).
# SHA256SUMS is the file scripts/build-release-assets.sh writes. IMAGE must
# be in the local docker (host/build-release.sh loads it by default).
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: $0 IMAGE VERSION SHA256SUMS" >&2
  exit 2
fi
image=$1 version=$2 sums=$3

status=0
for bin in impd imp; do
  # --entrypoint: the image's CMD is the host entrypoint, which needs KVM
  got=$(docker run --rm --entrypoint "$bin" "$image" --version)
  if [ "$got" != "$version" ]; then
    echo "check-release-image: $bin --version is $got, want $version" >&2
    status=1
  fi
done

# The image's two files must match the asset lines of the same name; the
# CLI binaries in SHA256SUMS are not in the image.
in_image=$(docker run --rm --entrypoint sh "$image" -c \
  'cd /usr/local/share/imp && sha256sum vmlinux imp-system.squashfs')
in_assets=$(grep -E '  (vmlinux|imp-system\.squashfs)$' "$sums" | sort -k2)
if [ "$(sort -k2 <<<"$in_image")" != "$in_assets" ]; then
  echo "check-release-image: the image's system files differ from $sums" >&2
  diff <(echo "$in_assets") <(sort -k2 <<<"$in_image") >&2 || true
  status=1
fi

if [ "$status" = 0 ]; then
  echo "check-release-image: ok ($image, $version)"
fi
exit "$status"
