#!/bin/bash
# Build the static agent and the imp system drive (squashfs) that holds it.
# Outputs: $IMP_BUILD/imp-agent, $IMP_BUILD/imp-agentctl,
#          $IMP_BUILD/imp-system.squashfs
#
# It builds the system-drive stage of host/Dockerfile, the same recipe as
# the release image, so the dev drive has the same bytes as the release one.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

mkdir -p "$IMP_BUILD"
docker buildx build -q -f "$IMP_ROOT/host/Dockerfile" --target system-drive \
  --output "type=local,dest=$IMP_BUILD" "$IMP_ROOT" >/dev/null
echo "$IMP_BUILD/imp-system.squashfs"
