#!/usr/bin/env bash
# Push main after running the pre-push gates on a clean worktree of the
# commit. The lefthook pre-push hook checks the live working tree, which
# holds other agents' unfinished files while work runs in parallel.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
wt="$root/.cache/push-wt"
[[ -d $wt ]] || git -C "$root" worktree add -q --detach "$wt" main
git -C "$wt" checkout -q --detach main
cd "$wt"
bun install --frozen-lockfile > /dev/null
for gate in format:check lint typecheck deadcode test; do
  if ! bun run "$gate" > "$root/.cache/push-$gate.log" 2>&1; then
    echo "push-checked: $gate failed; see .cache/push-$gate.log" >&2
    exit 1
  fi
done
cd "$root"
LEFTHOOK=0 git -C "$root" push -q origin main
echo "pushed $(git -C "$root" rev-parse --short main)"
