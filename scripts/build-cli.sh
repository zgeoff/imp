#!/bin/bash
# Compile one standalone imp CLI binary per platform into dist/, named
# imp-<target>. Every target cross-compiles from any host, so one runner
# builds the whole set. A target list on the command line narrows it.
#
#   scripts/build-cli.sh [target...]     e.g. scripts/build-cli.sh linux-x64
#
# Env: IMP_DIST (default dist/ in the repo) is the output directory. It is
#      not emptied first; scripts/build-release-assets.sh does that.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
dist=${IMP_DIST:-$root/dist}

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=(linux-x64 linux-arm64 darwin-x64 darwin-arm64)
fi

mkdir -p "$dist"
for target in "${targets[@]}"; do
  bun build --compile --target="bun-$target" "$root/packages/cli/src/main.ts" \
    --outfile "$dist/imp-$target"
done
