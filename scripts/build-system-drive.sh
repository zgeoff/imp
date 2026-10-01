#!/bin/bash
# Build the static agent and the imp system drive (squashfs) that holds it.
# Outputs: $IMP_BUILD/imp-agent, $IMP_BUILD/imp-agentctl,
#          $IMP_BUILD/imp-system.squashfs
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

mkdir -p "$IMP_BUILD"
(
  cd "$IMP_ROOT/agent"
  export CGO_ENABLED=0
  go build -trimpath -ldflags='-s -w' -o "$IMP_BUILD/imp-agent" ./cmd/imp-agent
  go build -trimpath -ldflags='-s -w' -o "$IMP_BUILD/imp-agentctl" ./cmd/imp-agentctl
)

ensure_host_image
# The drive is mounted read-only as the initial root, so the mountpoints
# stage 1 needs must already exist in it.
docker run --rm -v "$IMP_BUILD:/b" "$IMP_HOST_IMAGE" sh -euc '
  d=$(mktemp -d) && chmod 755 "$d"
  mkdir -p "$d/dev" "$d/proc" "$d/sys" "$d/newroot"
  cp /b/imp-agent "$d/imp-agent"
  mksquashfs "$d" /b/imp-system.squashfs -all-root -noappend -quiet -no-progress -comp zstd
  chown '"$(id -u):$(id -g)"' /b/imp-system.squashfs
'
echo "$IMP_BUILD/imp-system.squashfs"
