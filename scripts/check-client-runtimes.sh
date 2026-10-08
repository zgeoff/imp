#!/bin/bash
# Smoke a packed @zgeoff/imp-client (scripts/pack-client.sh) as its users run
# it: under Node, under Bun, and as a compiled Bun binary copied to an empty
# directory. Each runs packages/client/smoke/smoke.ts against run-stub-impd.ts,
# impd's own app with a fake agent, which runs from the workspace.
#
#   scripts/check-client-runtimes.sh build/npm/zgeoff-imp-client-X.Y.Z.tgz
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tarball=$(realpath "$1")
version=$(tar -xOzf "$tarball" package/package.json | jq -r .version)
smoke=$root/packages/client/smoke/smoke.ts
work=$(mktemp -d)
impd_pid=

cleanup() {
  if [ -n "$impd_pid" ]; then
    kill "$impd_pid" 2>/dev/null || true
    wait "$impd_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

bun "$root/packages/client/smoke/run-stub-impd.ts" > "$work/impd.json" &
impd_pid=$!

for _ in $(seq 100); do
  [ -s "$work/impd.json" ] && break
  kill -0 "$impd_pid" 2>/dev/null || { echo "run-stub-impd exited before it was ready" >&2; exit 1; }
  sleep 0.1
done
impd=$(head -1 "$work/impd.json")
[ -n "$impd" ] || { echo "run-stub-impd was not ready within 10 s" >&2; exit 1; }

# Node, installed with npm; 22.6 to 22.17 strip types only with the flag
mkdir "$work/node"
(
  cd "$work/node"
  npm init -y > /dev/null
  npm pkg set type=module
  npm install --no-audit --no-fund --silent "$tarball"
  cp "$smoke" smoke.ts
  echo "node $(node --version)"
  node --experimental-strip-types --no-warnings smoke.ts "$version" "$impd"
)

mkdir "$work/bun" "$work/bare"
(
  cd "$work/bun"
  echo '{ "name": "client-smoke", "private": true, "type": "module" }' > package.json
  bun add --silent "$tarball"
  cp "$smoke" smoke.ts
  echo "bun $(bun --version)"
  bun smoke.ts "$version" "$impd"

  bun build --compile smoke.ts --outfile smoke > /dev/null
)

# no node_modules and no package.json beside the binary: it holds the client
cp "$work/bun/smoke" "$work/bare/smoke"
(
  cd "$work/bare"
  echo "compiled bun binary"
  ./smoke "$version" "$impd"
)
