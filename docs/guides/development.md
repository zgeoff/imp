# Development

How to check a change before you push it, and what CI and the branch rules do with it. The
[install guide](./install.md) sets up the dev instance.

## Checks

```sh
bun run typecheck && bun run lint && bun test
bun run format:check && bun run deadcode
bun run lint:shell                # shellcheck over scripts/, host/ and test/
(cd agent && gofmt -l . && go vet ./... && go test -race ./...)   # gofmt -l lists unformatted files
scripts/acceptance.sh --clean     # end to end, from a clean state
```

`bun run lint:shell` needs shellcheck 0.11.0 on `PATH`, the version CI pins. Run
`scripts/acceptance.sh` against a real instance when a change touches the lifecycle, the agent or
the host; [STATUS.md](../../STATUS.md) has the latest results.

## Daemon tests

The daemon's tests need no VM. `packages/daemon/src/imps/test-imps.ts` runs the governed imp service
over an in-memory database and a fake VMM (`fake-vmm.ts`). A test scripts what the next boot, wake,
sleep, stop or agent check does (succeed, fail, die or hang), holds a step until it releases it, and
restarts impd over the same database and VMs. `findBrokenInvariants` reads the raw records, because
a read through the service repairs what it finds.

The property tests (`*.property.test.ts`) use fast-check. On a failure it prints the seed and the
path of the shrunk case. Pass both to `fc.assert` as `{ seed, path, endOnFailure: true }` to replay
the case.

## Git hooks

Lefthook installs the hooks with `bun install`.

- **pre-commit** fixes the staged files (oxlint, oxfmt, format-codemod), then runs gitleaks on them.
  gitleaks must be on `PATH`.
- **commit-msg** runs commitlint: conventional commits, lowercase, a header of 72 characters or
  fewer.
- **pre-push** runs the gates over the whole tree: format, lint, shellcheck, typecheck, deadcode and
  tests.

## CI

`.github/workflows/ci.yml` runs the gates on every push to `main` and every pull request, in four
jobs:

| Job          | What it runs                                                                  |
| ------------ | ----------------------------------------------------------------------------- |
| `gitleaks`   | A secret scan over the history.                                               |
| `checks`     | `bun run audit`, `deadcode`, `format:check`, `lint`, `typecheck`, `bun test`. |
| `go`         | `gofmt`, `go vet ./...` and `go test -race ./...` in `agent/`.                |
| `shellcheck` | `bun run lint:shell`.                                                         |

A new push to a pull request cancels its older run. Runs on `main` always finish.

## Branch rules

`.github/rulesets/main.json` protects `main`: the four CI jobs must pass, changes arrive through a
squash-merged pull request, and the branch cannot be deleted or force-pushed. Only a repository
admin can bypass it.

The ruleset is not applied yet. Apply it once:

```sh
gh api -X POST repos/zgeoff/imp/rulesets --input .github/rulesets/main.json
```
