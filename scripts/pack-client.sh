#!/bin/bash
# Build @zgeoff/imp-client and pack the tarball npm publishes, in
# build/npm/. Prints the tarball's path.
#
#   scripts/pack-client.sh
#
# The workspace package.json points `exports` at src/, so the CLI and the
# tests read the source with no build step. The packed manifest points at
# dist/ only, drops the dev fields, and must hold no catalog: or workspace:
# version, which an npm install cannot resolve.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
package=$root/packages/client
stage=$root/build/npm/imp-client

(cd "$package" && bun run build >&2)

rm -rf "$stage"
mkdir -p "$stage"
cp -R "$package/dist" "$package/README.md" "$root/LICENSE" "$stage/"

jq '
  del(.scripts, .devDependencies)
  | .exports = { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }
  | .files = ["dist"]
  | .sideEffects = false
  | .publishConfig = { access: "public" }
' "$package/package.json" > "$stage/package.json"

if grep -Eq '"(catalog|workspace):' "$stage/package.json"; then
  echo "pack-client: the packed package.json still has a catalog: or workspace: version" >&2
  exit 1
fi

name=$(cd "$stage" && npm pack --silent --pack-destination "$root/build/npm")
echo "$root/build/npm/$name"
