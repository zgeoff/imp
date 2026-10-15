#!/bin/bash
# Install a packed @impz/client (scripts/release/pack-client.sh) into an empty
# project, as a user would, and check that it imports under plain Node, with
# no Bun and no workspace, and that its types check in a strict project. The
# programs for both live in packages/client/smoke/.
#
#   scripts/release/check-client-package.sh build/npm/impz-client-X.Y.Z.tgz
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
smoke=$root/packages/client/smoke
tarball=$(realpath "$1")
project=$(mktemp -d)
trap 'rm -rf "$project"' EXIT

cd "$project"
npm init -y >/dev/null
npm pkg set type=module
npm install --no-audit --no-fund --silent "$tarball"

echo "node $(node --version)"

# the import under plain Node, and the README's examples against the published
# declarations only; both run here, where the tarball is installed
cp "$smoke/import-check.mjs" "$smoke/readme-example.ts" .
cp "$smoke/readme-example.tsconfig.json" tsconfig.json
node import-check.mjs "$(tar -xOzf "$tarball" package/package.json | jq -r .version)"

# no skipLibCheck, so the bundled declarations are checked too, which needs
# the optional peer @opentelemetry/api (the README says so)
npm install --no-audit --no-fund --silent @opentelemetry/api
"$root/node_modules/.bin/tsc" -p tsconfig.json
echo "the declarations check in a strict project"
