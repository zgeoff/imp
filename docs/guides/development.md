# Development

How to check a change before you push it, and what CI and the branch rules do with it. The
[install guide](./install.md) sets up the dev instance.

## Checks

```sh
bun run typecheck && bun run lint && bun test
bun run format:check && bun run deadcode
bun run lint:shell                # shellcheck over scripts/, host/, kernel/ and test/
(cd agent && gofmt -l . && go vet ./... && go test -race ./...)   # gofmt -l lists unformatted files
scripts/acceptance.sh --clean     # end to end, from a clean state
```

`bun run lint:shell` needs shellcheck 0.11.0 on `PATH`, the version CI pins. Run
`scripts/acceptance.sh` against a real instance when a change touches the lifecycle, the agent or
the host; [STATUS.md](../../STATUS.md) has the latest results.

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
required jobs:

| Job          | What it runs                                                                  |
| ------------ | ----------------------------------------------------------------------------- |
| `gitleaks`   | A secret scan over the history.                                               |
| `checks`     | `bun run audit`, `deadcode`, `format:check`, `lint`, `typecheck`, `bun test`. |
| `go`         | `gofmt`, `go vet ./...` and `go test -race ./...` in `agent/`.                |
| `shellcheck` | `bun run lint:shell`.                                                         |

The `cli` job also compiles the CLI for every platform (`bun run build:cli`) and runs the linux-x64
binary. It is not a required check. On `main`, the `release-please` and `release` jobs make releases
([RELEASING.md](../../RELEASING.md)).

A new push to a pull request cancels its older run. Runs on `main` always finish.

`.github/workflows/reproducible.yml` runs `host/check-reproducible.sh` (the guest kernel and the
system drive rebuild to the same bytes). It takes two cold kernel builds, so it runs by hand:
`gh workflow run reproducible.yml`.

## Branch rules

`.github/rulesets/main.json` protects `main`: the four CI jobs must pass, changes arrive through a
squash-merged pull request, and the branch cannot be deleted or force-pushed. Only a repository
admin can bypass it.

The ruleset is not applied yet. Apply it once:

```sh
gh api -X POST repos/zgeoff/imp/rulesets --input .github/rulesets/main.json
```
