#!/bin/bash
# Build the release host image: impd and the imp CLI compiled, the guest
# kernel and the system drive baked in. Nothing from the repo is mounted when
# it runs (deploy/ has the compose file and the systemd unit).
#
#   host/build-release.sh [buildx args...]
#
# Env: IMP_VERSION (default: git describe) labels the image and names its tag.
#      IMP_RELEASE_IMAGE (default imp-host) is the repository to tag.
# Extra args go to `docker buildx build`, for example --push or the
# --cache-from/--cache-to a CI runner needs to keep the kernel layer.
# Without --push or --output the image loads into the local docker.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
version=${IMP_VERSION:-$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo unknown)}
image=${IMP_RELEASE_IMAGE:-imp-host}

output=(--load)
for arg in "$@"; do
  case $arg in
    --push | --output* | -o*) output=() ;;
  esac
done

docker buildx build \
  -f "$root/host/Dockerfile" --target release \
  --build-arg IMP_VERSION="$version" \
  -t "$image:$version" \
  "${output[@]}" "$@" "$root"
echo "$image:$version"
