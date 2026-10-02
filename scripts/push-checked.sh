#!/usr/bin/env bash
# Push main after running the pre-push gates on a clean worktree of the
# commit. The lefthook pre-push hook checks the live working tree, which
# holds other agents' unfinished files while work runs in parallel.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
wt="$root/.cache/push-wt"
[[ -d $wt ]] || git -C "$root" worktree add -q --detach "$wt" main
git -C "$wt" checkout -q --detach main
if ! command -v shellcheck > /dev/null; then
  echo "push-checked: shellcheck is not on PATH; install 0.11.0, the version CI pins" >&2
  exit 1
fi
cd "$wt"
bun install --frozen-lockfile > /dev/null
for gate in format:check lint lint:shell typecheck deadcode test; do
  if ! bun run "$gate" > "$root/.cache/push-$gate.log" 2>&1; then
    echo "push-checked: $gate failed; see .cache/push-$gate.log" >&2
    exit 1
  fi
done
# the go job's gates, as CI runs them in agent/
unformatted=$(cd agent && gofmt -l .)
if [[ -n $unformatted ]]; then
  echo "push-checked: gofmt wants to reformat: $unformatted" >&2
  exit 1
fi
if ! (cd agent && go vet ./... && go test -race ./...) > "$root/.cache/push-go.log" 2>&1; then
  echo "push-checked: go failed; see .cache/push-go.log" >&2
  exit 1
fi
cd "$root"
LEFTHOOK=0 git -C "$root" push -q origin main
echo "pushed $(git -C "$root" rev-parse --short main)"
