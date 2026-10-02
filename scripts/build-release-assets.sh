#!/bin/bash
# Build every file a release attaches into dist/: the imp CLI for each
# platform, the guest kernel and the system drive, and SHA256SUMS over them.
# The release workflow runs this; run it locally for the same set. Nothing
# is pushed or published.
#
#   scripts/build-release-assets.sh [buildx args...]
#
# Extra args go to the `docker buildx build` of the kernel and the drive, for
# example the --cache-from a CI runner needs to keep the kernel layer.
#
# The kernel and the drive are for x86_64 guests only, as is the host image
# (host/build-release.sh): Firecracker and the guest kernel config are x86_64.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
dist=$root/dist

rm -rf "$dist"
mkdir -p "$dist"

IMP_DIST=$dist "$root/scripts/build-cli.sh"

docker buildx build \
  -f "$root/host/Dockerfile" --target system-files --platform linux/amd64 \
  --output "type=local,dest=$dist" "$@" "$root"

(cd "$dist" && sha256sum -- * >SHA256SUMS)
cat "$dist/SHA256SUMS"
