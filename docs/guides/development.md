# Development

How to check a change before you push it, and what CI and the branch rules do with it. The
[install guide](./install.md) sets up the dev instance.

## Checks

```sh
bun run typecheck && bun run lint && bun test
bun run format:check && bun run deadcode
bun run lint:shell                # shellcheck over scripts/, host/, kernel/ and test/
(cd agent && gofmt -l . && go vet ./... && go test -race ./...)   # gofmt -l lists unformatted files
scripts/test-e2e.sh --clean       # end to end, from a clean state
```

`bun run lint:shell` needs shellcheck 0.11.0 on `PATH`, the version CI pins. Run the end-to-end
harness against a real instance when a change touches the lifecycle, the agent or the host;
[STATUS.md](../../STATUS.md) has the latest results.

## End-to-end tests

`scripts/test-e2e.sh` brings up the dev instance (`scripts/dev.sh`), then runs each suite in
`test/e2e/suites/` as its own `bun test` process. Every case drives impd through the `imp` CLI, the
way a user would. The suites run in this order:

| Suite         | What it proves                                                                       |
| ------------- | ------------------------------------------------------------------------------------ |
| `lifecycle`   | new, exec (stdin, stderr, exit codes, `-t`), console, egress, stop and start, rm     |
| `docker`      | Docker in an `images/base` imp: run, build, a published port, egress, a cold boot    |
| `images`      | `imp image build`, the image's files, ENV and WORKDIR, image rm                      |
| `checkpoints` | checkpoint, restore (running and stopped), forks, labels, deletion                   |
| `sleep`       | idle sleep, wake by HTTP, API and WebSocket, memory kept, the WebSocket relay        |
| `scale`       | many imps under the RAM budget, LRU sleep, wake on request, an oversized imp refused |
| `restart`     | an impd restart re-adopts VMs; stopping the instance sleeps every imp                |
| `tailscale`   | an imp answers tailnet members and a tailnet request wakes it                        |

```sh
scripts/test-e2e.sh                          # the acceptance set: every suite
scripts/test-e2e.sh --only fast              # the CI subset: lifecycle, checkpoints, sleep, restart
scripts/test-e2e.sh --only checkpoints,sleep # named suites, run in the order above
scripts/test-e2e.sh --clean                  # wipe the dev instance's data first
```

| Flag      | Effect                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------- |
| `--only`  | Comma-separated suites or sets. `acceptance` (the default) is every suite; `fast` is the CI subset. |
| `--clean` | Logs the instance out of the tailnet, removes the container and wipes its data dir.                 |
| `--reuse` | Keeps a running dev instance instead of restarting it with the run's settings.                      |
| `--keep`  | Leaves the run's imps and fixture images in place for a look afterwards.                            |

The `acceptance` set is the definition of done: the tailscale suite fails without a
`TAILSCALE_AUTHKEY`, and the timing limits fail the run. Any other set skips tailscale without a key
and only warns about a missed limit. The `fast` set takes about 3.5 minutes, most of it idle
timeouts in the sleep suite. The full set adds docker, images, scale and tailscale; at its defaults
the scale suite alone took about 75 seconds in the last acceptance run.

`IMP_DEV_NAME`, `IMP_DEV_PORT_OFFSET` and `IMP_DEV_DATA` pick the dev instance, as for
`scripts/dev.sh`. These variables tune a run:

| Variable                | Default | Effect                                                   |
| ----------------------- | ------- | -------------------------------------------------------- |
| `E2E_RAM_BUDGET_MIB`    | 6144    | impd's RAM budget                                        |
| `E2E_IDLE_TIMEOUT_S`    | 10      | impd's idle timeout                                      |
| `E2E_SCALE_COUNT`       | 30      | imps the scale suite creates                             |
| `E2E_SCALE_MEMORY_MIB`  | 512     | memory of each scale imp                                 |
| `E2E_SCALE_FILL_MIB`    | 256     | tmpfs each scale imp fills                               |
| `E2E_MAX_NEW_MS`        | 3000    | limit for `imp new` plus the first exec                  |
| `E2E_MAX_CHECKPOINT_MS` | 500     | limit for a checkpoint of a running imp, as impd logs it |

The scale suite needs the budget plus 2 GiB of free host memory, and free disk on the data volume
for a memory snapshot of each imp (count × memory). It restarts the instance with a 600 s idle
timeout, so the RAM governor, not idleness, decides which imps sleep; the suites after it keep that
timeout. On a smaller machine, lower the budget and the count, for example
`E2E_RAM_BUDGET_MIB=2560 E2E_SCALE_COUNT=10`.

A run writes `.cache/e2e/results.json`: each suite's verdict and time, and the timings the suites
measure. A suite file also runs on its own against a running instance:
`bun test ./test/e2e/suites/sleep.e2e.ts`.

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

`.github/workflows/ci.yml` runs these jobs on every push to `main` and every pull request:

| Job          | Required | What it runs                                                                          |
| ------------ | -------- | ------------------------------------------------------------------------------------- |
| `gitleaks`   | yes      | A secret scan over the history.                                                       |
| `checks`     | yes      | `bun run audit`, `deadcode`, `format:check`, `lint`, `typecheck`, `bun test`.         |
| `go`         | yes      | `gofmt`, `go vet ./...` and `go test -race ./...` in `agent/`.                        |
| `shellcheck` | yes      | `bun run lint:shell`.                                                                 |
| `cli`        | yes      | Compiles the CLI for every platform (`bun run build:cli`) and runs the linux-x64 one. |
| `client`     | yes      | Packs `@zgeoff/imp-client` and installs it on the oldest Node it supports.            |
| `e2e`        | yes      | The `fast` end-to-end set on real microVMs (below).                                   |

On `main`, the `release-please` job makes releases ([RELEASING.md](../../RELEASING.md)).

### The e2e job

The `e2e` job boots real Firecracker guests on a standard `ubuntu-24.04` runner (4 cores, 16 GB),
which exposes `/dev/kvm`. `scripts/check-kvm.sh` runs first, so a runner without KVM fails in
seconds with the reason. The job then:

1. builds the guest kernel and the system drive from the `system-files` stage, with the release's
   GitHub Actions cache (scope `system-files`): the kernel rebuilds only when `kernel/version` or
   the kernel config files change, or after GitHub evicts the cache (7 days unused, or the repo's 10
   GB quota). A cold kernel build takes about 10 minutes, so the job's timeout is 25.
2. builds the dev host image with a cache of its own (scope `imp-dev`) and sets
   `IMP_HOST_IMAGE_READY=1`, so `scripts/dev.sh` uses it instead of building it again. Only runs on
   `main` write these caches; pull requests only read them.
3. runs `scripts/test-e2e.sh --only fast` with `E2E_RAM_BUDGET_MIB=4096`,
   `IMP_DEFAULT_MEMORY_MIB=1024` and the XFS file on the runner's `/mnt` disk. There is no Tailscale
   key in CI, and a missed timing limit only warns.

After a pass, a failure or a timeout, the job saves the `e2e-results` artifact (14 days):
`results.json`, `metrics.jsonl` and `impd.log`, the dev container's whole log. A failed suite also
prints the last 40 lines of impd's log inline. Download the artifact with
`gh run download <run-id> -n e2e-results`.

The job is a required check, and `release-please` waits for it. It became one after it passed on
every push to `main` from its first run (#2).

If GitHub-hosted runners lose KVM, move the job to an ephemeral, dedicated self-hosted runner and
run it only on push to `main`, never on pull requests. Never use the deploy box. The repo is public,
so a pull request from a fork would get a privileged container with `/dev/kvm` on that runner.

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
