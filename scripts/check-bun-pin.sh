#!/bin/bash
# Fail when the host image's bun differs from the repo's bun: .bun-version,
# packageManager in package.json, and the oven/bun tag in host/Dockerfile.
set -euo pipefail
cd "$(dirname "$0")/.."

file=$(tr -d '[:space:]' <.bun-version)
manager=$(jq -r '.packageManager | sub("^bun@"; "")' package.json)
image=$(sed -nE 's#^FROM oven/bun:([^@ ]+)@sha256:[0-9a-f]{64} .*#\1#p' host/Dockerfile)

if [ -z "$image" ]; then
  echo "check-bun-pin: host/Dockerfile has no FROM oven/bun:<version>@sha256:<digest>" >&2
  exit 1
fi
if [ "$file" != "$manager" ] || [ "$file" != "$image" ]; then
  echo "check-bun-pin: .bun-version $file, packageManager $manager, host/Dockerfile $image" >&2
  exit 1
fi
echo "check-bun-pin: bun $file everywhere"
