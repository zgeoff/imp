#!/bin/bash
# Install a packed @zgeoff/imp-client (scripts/pack-client.sh) into an empty
# project, as a user would, and check that it imports under plain Node, with
# no Bun and no workspace, and that its types check in a strict project.
#
#   scripts/check-client-package.sh build/npm/zgeoff-imp-client-X.Y.Z.tgz
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tarball=$(realpath "$1")
project=$(mktemp -d)
trap 'rm -rf "$project"' EXIT

cd "$project"
npm init -y > /dev/null
npm pkg set type=module
npm install --no-audit --no-fund --silent "$tarball"

echo "node $(node --version)"

node --input-type=module - "$(tar -xOzf "$tarball" package/package.json | jq -r .version)" <<'JS'
import assert from 'node:assert/strict';
import * as client from '@zgeoff/imp-client';

const imp = client.createImpClient({ url: 'http://impd.test/', token: 't' });

assert.equal(client.CLIENT_VERSION, process.argv[2]);
assert.equal(typeof imp.imps.create, 'function');
assert.equal(typeof imp.requireAwake, 'function');
assert.equal(typeof client.isDefinedError, 'function');

console.log(`imported @zgeoff/imp-client ${client.CLIENT_VERSION}`);
JS

# the README's examples, against the published declarations only
cat > example.ts <<'TS'
import { createImpClient, isDefinedError, safe } from '@zgeoff/imp-client';
import type { Imp } from '@zgeoff/imp-client';

const imp = createImpClient({ url: 'http://localhost:7070', token: 'token' });

export async function example(): Promise<Imp> {
  const checkpoint = await imp.checkpoints.create({ name: 'dev', label: 'clean' });

  await imp.imps.fork({ source: 'dev', name: 'dev-2', checkpoint: checkpoint.id });

  const [error, created] = await safe(imp.imps.create({ name: 'dev' }));

  if (isDefinedError(error) && error.code === 'RAM_BUDGET_EXCEEDED') {
    throw new Error(`needs ${String(error.data.requestedMib)} MiB`);
  }

  const check = await imp.checkServer();

  return check.compatible && created !== undefined ? created : imp.requireAwake('dev');
}
TS

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": [],
    "noEmit": true
  },
  "files": ["example.ts"]
}
JSON

# no skipLibCheck, so the bundled declarations are checked too, which needs
# the optional peer @opentelemetry/api (the README says so)
npm install --no-audit --no-fund --silent @opentelemetry/api
"$root/node_modules/.bin/tsc" -p tsconfig.json
echo "the declarations check in a strict project"
