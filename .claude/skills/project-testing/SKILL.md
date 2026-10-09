---
name: project-testing
description:
  imp's test harness facts — the KVM end-to-end harness and its dev instance, ZFS on a fake and on
  real pools, connectors and the broker's test upstreams, host networking in namespaces, Pebble
  ACME, and the small-filesystem build test. Loaded together with the testing skill, whenever you
  design, write, run, or review tests in this repo.
---

# imp test harnesses

This skill lists the runs, harnesses, and stand-ins that exist in this repo today, with the paths
and variables that drive them. It describes the code as it is, not what the testing skill allows;
the rules for writing tests live in the testing skill.

## Runs

| Run                     | Command                                                                | Needs                                                                                   |
| ----------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Unit and package tests  | `bun test` at the root                                                 | Bun, bash, git, jq, tar, truncate, mkfs.ext4; the gated files below skip                |
| Dashboard components    | `bun run test:dashboard`                                               | Nothing beyond Bun                                                                      |
| Agent Go tests          | `scripts/test-go.sh` (JSON to `$GO_TEST_JSONFILE`, or a new temp file) | Go from `agent/go.mod`; root-only tests skip                                            |
| End to end              | `scripts/test-e2e.sh`                                                  | KVM, Docker; some suites need more (below)                                              |
| Host networking         | `sudo env "PATH=$PATH" IMP_HOST_TESTS=required bun run test:host`      | Root or unprivileged namespaces, `nft`, `iptables`, `ip6tables`, `ip`, `ping`, `sysctl` |
| ZFS on a real pool      | `sudo env "PATH=$PATH" scripts/test-zfs.sh`                            | Root, the zfs module, `zpool`                                                           |
| ZFS on a host, with VMs | `scripts/zfs-host-test.sh`                                             | sudo, Docker, KVM, the zfs module                                                       |
| Build disk hold         | `IMP_TEST_SMALL_FS=<dir> bun test <file> -t 'small filesystem'`        | A small filesystem mounted at `<dir>`                                                   |
| ACME issuer             | `bun run test:pebble`                                                  | Docker                                                                                  |

Plain `bun test` runs the shell scripts in `scripts/` and `deploy/` with bash, `deploy/upgrade.sh`'s
tests need `jq`, and `release-please-config.test.ts` and `scripts/check-doc-refs.ts` run `git`.

The build disk hold's `<file>` is `packages/daemon/src/images/isolated-build.test.ts`; its
small-filesystem tests skip unless `IMP_TEST_SMALL_FS` names a directory. Each trial measures the
filesystem with `packages/daemon/src/test-utils/start-disk-sampler.ts`, which removes its filler
file when the test ends.

The root `bunfig.toml`'s `pathIgnorePatterns` skips `packages/dashboard/**`, so the dashboard's
tests run from the package. Its `bunfig.toml` preloads `@zgeoff/bun-test-extended`,
`@zgeoff/bun-test-react` (happy-dom, the jest-dom matchers, and an unmount after each test), then
`packages/dashboard/test-setup.ts`. That preload runs the shared run hooks (a seeded faker and env
restores), sets the page's URL to `http://impd.test/ui/`, wraps `fetch` so a request to that origin
carries `Sec-Fetch-Site: same-origin` as a browser's does
(`src/test-utils/build-stub-browser-fetch.ts`), restores spies and mocks after each test, and runs
the dashboard's own MSW server (`src/mocks/node.ts`). Its handlers (`src/mocks/handlers.ts`) answer
impd's `/auth/login`, `/auth/logout` and `/rpc/*` at `http://impd.test`, so the real SDK's fetch
reaches them. `/rpc/*` runs oRPC's own fetch handler over `src/mocks/impd-router.ts`, an
`implement(impContract)` router of the procedures the dashboard calls. It reuses impd's own code
from `packages/daemon`: `checkAccess` and the builder check on every call, the errors of
`api-errors.ts`, `requireTransition` for lifecycle moves, `resolveCpuSettings`, `deriveImageName`,
the ssh key parser, `isSameOrigin`, `toLeaseSummary`, `createLogouts` and `openEventStream`. A few
small functions are copied with a comment instead, because their modules pull Bun-only types into
the dashboard's DOM typecheck or are not exported. A procedure it leaves out answers impd's
`not found` 404. The router reads and writes the `@msw/data` collections in `src/mocks/db/` (imps,
checkpoints, images, tokens with their secrets, sessions, secrets, imp policies, and the host, whose
default row the first read keeps; `system.info` derives its counts from the imp rows), which the
preload empties after each test with `resetMockDb`. Lists come back in impd's order: imps and tokens
by name, checkpoints newest first. A row in the sessions collection stands for the one browser's
session cookie, which Bun's fetch does not keep. It holds the token's id, as impd's `tokenId`, and
each call re-reads that token, so a changed token takes effect at once and a deleted one, even if a
new token takes its name, logs nobody in. A call gets impd's 401 without a session, after its
`expiresAt`, once its token is gone, or from another origin. Login with a token's secret replaces
the session; logout clears it and ends every open event stream. A test logs in with
`createDashboardSession` (`src/test-utils/create-dashboard-session.ts`). Lifecycle calls emit impd's
events; `emitImpdEvent` sends one for a change made elsewhere, each stream passes only the events of
the session's imps, and the preload clears `impdEventListeners`. `src/test-utils/render-app.tsx`
(`renderApp`) mounts the whole app with the production `createBrowserImpd`, and `read-rpc-input.ts`
reads a call's input in a per-test MSW handler.

The root preload is `packages/test-utils/src/preload.ts`, ahead of `@zgeoff/bun-test-extended`;
`packages/test-utils/bunfig.toml` repeats it for a run from that package. It seeds faker, restores
every `updateEnv` override after each test, and runs one MSW server
(`packages/test-utils/src/mock-server.ts`) for the whole run with `onUnhandledRequest: 'error'`. The
server intercepts `fetch` only; `node:http` clients and WebSockets stay native. While it listens,
the global `fetch` sends a request to a loopback host or over a unix socket to the native fetch
(`route-fetch.ts`), and every other request to MSW. The end-to-end suites run with
`test/e2e/bunfig.toml`, whose preload (`preload-e2e.ts`) restores env overrides and seeds faker,
with no MSW server. `updateEnv`, `invariant` and `waitFor` live in `packages/test-utils/src`.

### Cleanup order

On Bun 1.4.2, `onTestFinished` callbacks run in the order they were registered, and when one throws,
the ones after it are skipped. A util that registers its own cleanup is therefore released before
anything the test registers after calling it. These utils register their own: `startStubAgent` (its
`close` may also run earlier; given `{ stack }`, it defers the close there instead),
`startStubExecAgent`, `startStubSessionAgent` and `startStubAttachAgent` (through `startStubAgent`,
so each also takes `{ stack }`), `startStubDnsUpstream`, `createTestDatabase`,
`createUnmigratedDatabase` (it closes the SQLite handle itself, since Kysely closes a driver only
after a query started it), `buildQueryGate` (it releases a held select), `setupImpTest` and
`setupMoveHosts`.

`setupImpTest` and `createTestDatabase` still carry a transitional `[Symbol.asyncDispose]`, for area
branches that hold them with `await using`; a later GEO-135 PR removes it once those branches land.

Utils that take a caller's stack and register nothing themselves:

- `createImpTest(stack, options)` in `imps/test-imps.ts`: the `setupImpTest` harness.
- `createMoveHosts(stack, options)` in `moves/test-moves.ts`: the two `setupMoveHosts` impds.
- The broker stand-ins `test-utils/start-stub-broker-*.ts` that start something: the TLS and plain
  upstreams, the reply and hold targets, the guest socket and the tunnel.
- `runWithStack(body)` in `test-utils/run-with-stack.ts`: runs `body` with a fresh stack and
  releases it once `body` settles or throws.
- `startStubEchoServer(stack)` in `test-utils/start-stub-echo-server.ts`: a tunnel's far end on
  loopback.
- `createZfsTestDataset(stack, options)` in `test-utils/create-zfs-test-dataset.ts`: a real-pool
  test's own dataset (see ZFS below).

`packages/daemon/src/create-impd.test.ts` returns its stack as `ctx.stack`.
`packages/test-utils/src/run-child-tests.ts` (`runChildTests(dir, source)`) runs one test file in a
child `bun test` with `dir` as its working and temp dir.

Plain `bun test` does not match `*.e2e.ts` or `*.pebble.ts`; each of those runs only when its `./`
path is given. The `*.real.test.ts` files and the small-filesystem tests load in plain `bun test`
and skip unless their variables are set. The `*.host.test.ts` files load too, and each test skips
where its namespace probe fails; `bun run test:host` runs exactly those files.

## End-to-end harness

`scripts/test-e2e.sh` runs `test/e2e/main.ts`. The harness:

1. Brings the dev instance down and up with `scripts/dev.sh` (`--reuse` keeps a running one), then
   checks the container's privileges against `deploy/` with `test/e2e/lib/privileges.ts`.
2. Reads the API token with `scripts/dev.sh token` and sets `IMP_TOKEN` and `IMP_HOST_IMAGE`.
3. Resets the baseline for every suite's prefix (below), then builds the fixture images the selected
   suites list and impd does not have yet. This startup reset removes only what a suite prefix
   names, so an `e2e-` imp that matches no suite prefix survives it (the end-of-run cleanup in step
   6 still takes every `e2e-` imp and image). A removal impd refuses, such as `CONFLICT` for an
   image another imp boots, fails setup, and no suite runs.
4. Runs each suite as its own process group (`test/e2e/lib/run-suite.ts`),
   `bun test --config=test/e2e/bunfig.toml --bail --timeout 3600000 ./test/e2e/suites/<name>.e2e.ts`,
   in the order of `SUITES` in `test/e2e/lib/suites.ts`. The first SIGINT or SIGTERM stops the
   running suite's group and runs no more suites; a second exits at once. The harness forgets the
   suite's group as soon as it exits, before any reset, and `stopSuiteGroup` treats a group that is
   already gone (`ESRCH`) as stopped, so a signal during a reset does not crash the run.
5. After each suite, whether it passed, failed or was stopped, resets the baseline for its prefix
   (`e2e-<abbr>-`), unless `--keep`. After a suite that failed, and before that reset, it reboots
   the instance with the run's settings (`scripts/dev.sh reboot`), since the suite may have left
   impd rebooted onto its own; an interrupted run skips that reboot. `scale` keeps its imps when
   `restart` runs after it, and `restart`'s reset takes them; then `scale` gets neither the reset
   nor the reboot, even when it fails, so `restart` runs on whatever `scale` left. A suite whose
   process cannot start, or whose checks throw, fails like one that exits non-zero, and the run goes
   on. A reset or reboot that fails fails the suite, and the harness then makes the instance anew
   (the `--clean` reset below, then up with the run's settings, privilege check, token and fixture
   images) and runs on; if that fails too, the run stops with the reason and fails. On the ZFS
   backend that reset also empties the run's root dataset (below). It also fails a suite when the
   impd log shows a boot-template fallback (the `chaos` suite may cause one). The loop is
   `runSuites` in `test/e2e/lib/run-suites.ts`, which takes each step as a dependency;
   `run-suites.test.ts` checks the order of runs, reboots, resets and re-creations.
6. Unless `--keep`, or the instance could not be made anew, removes every `e2e-` imp and image, then
   writes `.cache/e2e/results.json`, merging the metrics suites append to `.cache/e2e/metrics.jsonl`
   (`E2E_METRICS_FILE`). The run passes only when every section passed, nothing stopped it, and no
   SIGINT or SIGTERM came, even one during the last reset or the cleanup (`checkRunPassed`); an
   interrupted run exits 130.

The wipe of `--clean` and of a re-creation deletes the data dir as root, so `main.ts` wipes only a
dir under `<repo>/.data/` or one that holds an `imp.xfs` (`resolveWipeTarget` in
`test/e2e/lib/wipe-target.ts`). On the ZFS backend (`IMP_STORAGE_BACKEND=zfs`, as
`scripts/zfs-host-test.sh` runs it) it first asks `readZfsOwner` in `test/e2e/lib/zfs-owner.ts`,
wherever the dir sits, so a proven pool's root is emptied along with the data; a dir it cannot prove
falls back to the two rules above. The proof: the owner file `imp-e2e-zfs-owner` that
`zfs-host-test.sh` writes into it parses, its root is `IMP_ZFS_ROOT` and sits in its pool, its vdev
sits beside the data dir, and `zpool status -P` lists that vdev in that pool. Then the wipe keeps
the owner file, and `resetZfsRoot` destroys the root dataset with all its descendants
(`zfs destroy -R`) and makes it again. `zpool` and `zfs` run in a privileged container of the host
image. `zfs-owner.test.ts` checks each proof and the reset against a stand-in command runner; no
test runs them on a real pool.

The baseline reset, `resetBaseline` in `test/e2e/lib/reset-baseline.ts`, takes impd's client
(`createInstanceClient` in `imp-cli.ts`, the run's root token) and a list of prefixes. It removes
every imp named with one, and with it the imp's checkpoints, leases and the grants it holds; then
the networks, secrets, OAuth clients, tokens, and images and templates named with one; then
`<IMP_DEV_DATA>/broker-test-upstreams.json`. A fixture image (`e2e-<fixture>-<hash>`) carries no
suite prefix and stays. A removal impd refuses, such as an image another imp boots, rejects the
reset. `reset-baseline.test.ts` boots impd's real app (`createImpd` on the stub VMM) in process,
makes each of those kinds, resets, and reads every list back before and after; it also checks that
an unprefixed name, a near-miss prefix (`e2e-xy-` against `e2e-x-`) and an unprefixed OAuth client
stay. Sessions and services are not proven: making either needs a guest agent, which the stub VMM
has no stand-in for. What the reset does not cover: the instance's own settings (the reboot after a
failure restores those), the `moves` suites' second host (`removeMoveLeftovers` at the end of a run
that includes them), and a registry container or SSH key a suite file made.

A suite file also runs alone against an instance that is up:
`bun test --config=test/e2e/bunfig.toml ./test/e2e/suites/sleep.e2e.ts`. Nothing then resets the
baseline or builds missing fixture images for it; `setupSuite` in `test/e2e/lib/setup-suite.ts` only
returns the suite's prefix and registers no hooks. `runDevScript` passes the run's
`IMP_RAM_BUDGET_MIB` and `IMP_IDLE_TIMEOUT_S` (from `config.ts`) under whatever `process.env` sets:
a suite that reboots the instance onto its own tuning sets them in `process.env`, and that must win.
So a shell's `IMP_RAM_BUDGET_MIB` or `IMP_IDLE_TIMEOUT_S` wins when a suite file runs alone; through
`main.ts` the two match the config.

Flags: `--only <suites or sets>`, `--group <1|2|3>`, `--clean`, `--reuse`, `--keep`; `--help` lists
the suites. The sets live in `SUITE_SETS`: `acceptance` (the default) is every suite, and `fast` is
the CI subset. `main.ts` sets `E2E_ACCEPTANCE=1` when the run includes `acceptance`; tailnet suites
then fail instead of skipping, and the timing limits fail the run instead of warning. `scale` is not
in `fast`; the acceptance run keeps it before `restart` on the same instance.

`--group N` runs `FAST_GROUPS[N - 1]` from `suites.ts`: three static lists that split `fast`, each
in `SUITES` order, for three runners with an instance each. `suites.test.ts` checks that they hold
every fast suite once and nothing else. They came to about 225 s of suite work each in two CI runs:

| Group | Suites                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | lifecycle, registry, checkpoints, disks, restart, offsets, session-logs, services, ssh, ssh-agent, proxy, dashboard, tokens, leases, cpu, templates, boot-templates, socket |
| 2     | sleep, reverse, jail                                                                                                                                                        |
| 3     | mcp, inner, memory, ksm                                                                                                                                                     |

`HOST_TESTS_GROUP` (2) names the group whose runner also runs `bun run test:host`, so those tests
run once.

Fixture images come from `images/base` (`base`, a slow Docker build) and `test/e2e/fixtures/`
(`e2e-tiny`, `e2e-bare`, `e2e-ws`, `e2e-git`, `e2e-ra`). A fixture's name carries a hash of its
sources, so a changed fixture builds anew.

| Variable                             | Default     | Effect                                             |
| ------------------------------------ | ----------- | -------------------------------------------------- |
| `E2E_RAM_BUDGET_MIB`                 | 6144        | impd's RAM budget, passed through `scripts/dev.sh` |
| `E2E_IDLE_TIMEOUT_S`                 | 10          | impd's idle timeout                                |
| `E2E_SCALE_COUNT`                    | 30          | imps the scale suite creates                       |
| `E2E_SCALE_MEMORY_MIB`               | 512         | memory of each scale imp                           |
| `E2E_SCALE_FILL_MIB`                 | 256         | tmpfs each scale imp fills                         |
| `E2E_MAX_NEW_MS`                     | 3000        | limit for `imp new` plus the first exec            |
| `E2E_MAX_CHECKPOINT_MS`              | 500         | limit for a checkpoint of a running imp            |
| `E2E_CHAOS_ROUNDS`, `E2E_CHAOS_SEED` | 8, random   | the chaos suite's rounds and replay seed           |
| `IMP_DEV_NAME`                       | `imp-dev`   | the dev container                                  |
| `IMP_DEV_PORT_OFFSET`                | 0           | shifts every published port; needs `IMP_DEV_NAME`  |
| `IMP_DEV_DATA`                       | `.data/dev` | the instance's data dir, mounted at `/data`        |

`main.ts` sets `E2E_KEEP`, `E2E_ACCEPTANCE`, and `E2E_METRICS_FILE` for each suite process. It no
longer sets `E2E_SUITES`: `scale` read it to keep its imps for `restart`, and that choice is now the
harness's (step 5). Suites that reboot the instance pass impd settings through `process.env`, which
`scripts/dev.sh` forwards from its allowlist.

Suites with extra needs:

| Suite                        | Needs, or skips without                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `tailscale`, `moves-tailnet` | A Tailscale key and this machine `Running` on the tailnet; skips outside `acceptance`        |
| `tailscale` per-imp names    | `IMP_E2E_TAILNET_NAMES=1` and the OAuth client in 1Password                                  |
| `registry`                   | `imp-e2e-registry.test` resolving to 127.0.0.1 and passwordless sudo; fails when `CI` is set |
| `ksm`                        | `/sys/kernel/mm/ksm/run` set to 1 and a kernel of 6.10 or later                              |
| `https`                      | Pebble, which `main.ts` starts only when the run includes `https`                            |
| `moves`, `moves-tailnet`     | A second instance, `<IMP_DEV_NAME>-mv-b` with data in `<IMP_DEV_DATA>-mv-b`                  |
| `dashboard`                  | Playwright's Chromium; runs `packages/dashboard`'s `bun run e2e` against the instance        |
| `lifecycle` and others       | Public internet from the guest (`example.com`) and for fixture image pulls                   |

The Tailscale key comes from `TAILSCALE_AUTHKEY`, else a 1Password read of
`IMP_TAILSCALE_AUTHKEY_REF` when `IMP_TAILSCALE_OP=1`, else `TAILSCALE_AUTHKEY` in `.env`
(`load_tailscale_authkey` in `scripts/lib.sh`). `main.ts` sets `IMP_TAILSCALE_OP=1` only when the
run includes `tailscale` or `moves-tailnet`.

The `test/e2e/lib/*.test.ts` unit tests run in plain `bun test` and need no KVM, Docker or dev
instance. Some start real processes: `reset-baseline.test.ts` boots impd's app in process
(`createImpd` on the stub VMM), and `run-suite.test.ts` spawns Bun processes and their children. A
test or stand-in that runs git, or a tool that runs it (`git receive-pack`, `git http-backend`),
spawns it through `runGitCommand`, `runGitChecked` or `createGitFreeEnv` in
`test/e2e/lib/git-env.ts`: a git hook exports `GIT_DIR` and the other variables
`git rev-parse --local-env-vars` lists into `bun test`, and a git child that inherits them works on
this checkout whatever its `-C` says.

## ZFS

- **The fake.** `packages/daemon/src/test-utils/build-stub-zfs.ts` (`buildStubZfs`) answers impd's
  `zfs` argv (`run`), send and receive streams (`streams`), and `/proc/self/mounts` (`readMounts`)
  in memory. It models datasets, snapshots, clones, promote, deferred destroy, legacy mounts, and
  txg-based `creation` (`readCreatedAt`), with fixed space numbers, and answers `umount -R` and
  `zfs destroy -R`. It exposes `blockBefore` (its `reached` resolves once a matching command waits;
  `release` lets it run), `failOnce`, `crashBefore`, and `restart`. `zfs-backend.ts` takes it
  through those injected deps, and `createStorageBackend` passes them through its `zfs` boundary. As
  util-linux does, its `umount -R` refuses a dir that is not itself a mount.
  `test-utils/build-stub-move-stream.ts` (`buildStubMoveStream`) is a peer's move stream: a source's
  bytes, then an `onEnd` hook and a close, or a `failAtEnd` error.
- **The real-pool tests.** `zfs-backend.real.test.ts`, `zfs-move.real.test.ts`, and
  `zfs-move-flow.real.test.ts` skip unless `readZfsTestPool()` (`test-utils/read-zfs-test-pool.ts`)
  finds `IMP_TEST_ZFS_ROOT` (a dataset) and `IMP_TEST_ZFS_DIR` (its mount dir) both set. Each test
  makes its own dataset with `createZfsTestDataset`: a new `mkdtemp` dir under the mount dir names
  it, a dataset of that name that `zfs list` already shows is refused untouched, and the caller's
  stack releases only what was made (`umount -R` of the dir, `zfs destroy -R`, then the empty dir).
  Its tests run it against `buildStubZfs`. `test-utils/write-synced-file.ts` fsyncs a disk file
  before a snapshot.
- **`scripts/test-zfs.sh`** runs as root. It makes a sparse-file pool `imptest<pid>` of
  `IMP_ZFS_TEST_GIB` (default 4) under `IMP_ZFS_TEST_DIR` (default a new temp dir; a given dir may
  exist), mounts `<pool>/imp` with a legacy mount on `<dir>/mnt`, runs
  `bun test packages/daemon/src/storage/zfs` with both gates set, and destroys the pool on exit. The
  run includes the fake-backed tests in that folder. Before it touches anything it refuses a pool
  name that `zpool list` already shows, and a `pool.img` or `mnt` already in the work dir; a work
  dir that does not exist yet is made, parents included. It flags each thing it makes (work dir,
  `mnt`, `pool.img`), and its EXIT cleanup releases only those, in reverse order. The pool is proven
  rather than flagged, since a signal during `zpool create` runs the trap only once the create has
  finished: cleanup destroys the pool only when `zpool status -P` lists this run's `pool.img` as its
  vdev, matching the whole path even when it holds spaces, and removes `pool.img` only when no pool
  lists it; when `zpool` cannot answer, the file stays and the run fails. So a failed `zpool create`
  destroys no pool, and a pool that will not go keeps its file and fails the run. A `pool.img` that
  is a symlink is refused too. The tests run in the background, so TERM (exit 143) or INT (130)
  stops them before cleanup. It reads the module's version from `IMP_ZFS_MODULE_VERSION_FILE`
  (default `/sys/module/zfs/version`). `scripts/test-zfs.test.ts` runs the script against stub `id`,
  `zfs`, `mount`, `umount` and `bun` on `PATH` (`scripts/test-utils/create-stub-bin.ts`), and a
  `zpool` that keeps its pools in a state file (`create-stub-zpool.ts`), in a temp root: a normal
  release, a work dir made with its parents, the collisions (a symlinked `pool.img` included), a
  failed `zfs create`, a failed `zpool create`, a failed destroy, a pool that still uses the file, a
  failed `zpool` query, a work dir path with spaces, and SIGTERM during the create and mid-run.
- **`scripts/zfs-host-test.sh`** runs `test-zfs.sh` (unless `IMP_ZFS_TEST_UNIT=0`), then starts a
  dev instance `imp-zfs` (port offset `IMP_DEV_PORT_OFFSET`, default 300) with
  `IMP_STORAGE_BACKEND=zfs` on a second sparse pool `impbench<pid>` of `IMP_ZFS_BENCH_GIB`
  (default 40) in `<dir>/bench.img`, runs the suites in `IMP_ZFS_E2E_SUITES` (default
  `checkpoints,sleep`), and writes `<dir>/summary.txt`; `<dir>` keeps the results and is made,
  parents included, when it does not exist. Before it touches anything it refuses a bench pool name
  that `zpool list` already shows, a `bench.img` (a symlink included) or `data` already in the work
  dir, and an `imp-zfs` container that is already there; so a second run in the same dir is refused.
  It claims `<dir>/data` with `mkdir`, and once the pool and root dataset exist it writes the owner
  file `imp-e2e-zfs-owner` there, which lets `main.ts` make the instance anew (see the end-to-end
  harness). The e2e run goes in the background, its output through `tee` into `<dir>/e2e.log`, so
  TERM (143) or INT (130) reaches the trap at once and cleanup stops it first. Its EXIT cleanup
  releases only what the run made: it collects the impd log and stops the instance only once the run
  started it, destroys the pool only when `zpool status -P` lists this run's `bench.img` (the whole
  path), and removes that file only when no pool lists it and `zpool` could say so. A pool that will
  not go keeps its file and fails the run. `IMP_ZFS_MODULE_VERSION_FILE` is read as in
  `test-zfs.sh`. `scripts/zfs-host-test.test.ts` runs a copy of the script beside the real `lib.sh`
  and stand-in `dev.sh`, `test-e2e.sh` and `test-zfs.sh`, with stub `sudo`, `zfs` and `docker` and
  the stateful `zpool` on `PATH`: a normal release with its owner file, a work dir made with its
  parents, the pool, file, symlink, data dir and container collisions, a failed `zpool create`, a
  failed destroy, a pool that still uses the file, a failed `zpool` query, a work dir path with
  spaces, and SIGTERM during the create and during the e2e run.

## CI

`.github/workflows/ci.yml`:

- **`checks`** runs `bun test`; the build disk hold on a 4 GiB loop-mounted XFS that it formats,
  mounts with sudo, and names in `IMP_TEST_SMALL_FS`; `bun run test:pebble`; and
  `bun run test:dashboard`.
- **`e2e-group`** runs the end-to-end work as a matrix of three groups, one KVM runner each, with
  `fail-fast: false` so every group reports. Each runs `scripts/check-kvm.sh` first, hands the cpu
  cgroup controller to containers, turns KSM on, picks `/mnt/imp-e2e` or `.data/ci` as
  `IMP_DEV_DATA`, builds inputs with `.github/actions/e2e-build`, adds `imp-e2e-registry.test` to
  `/etc/hosts`, and runs `scripts/test-e2e.sh --group <n>` with `E2E_RAM_BUDGET_MIB=4096` and no
  Tailscale key. Only group 2 runs the host networking tests as root with `IMP_HOST_TESTS=required`,
  only group 1 sets up Playwright's browser (`if: matrix.browser`), and only group 1 on a push to
  `main` writes the build caches (`WRITE_CACHE`, which `.github/actions/e2e-build` takes as
  `write-cache`). `Cache Bun Packages` is a plain `actions/cache` step in all three groups, so any
  group may save the Bun package cache when its key misses. Each uploads `.cache/e2e/` and
  `packages/dashboard/.test-results/` as `e2e-results-<n>`. `test/e2e/lib/ci-groups.test.ts` pins
  these against the workflow file.
- **`e2e`** (a required check) is the aggregate: it needs `e2e-group` and passes only when
  `needs.e2e-group.result` is `success`.
- **`zfs`** (not required) runs `scripts/check-kvm.sh`, installs ZFS, runs `scripts/test-zfs.sh`
  with `IMP_ZFS_TEST_DIR` blank, then `scripts/zfs-host-test.sh` with `IMP_ZFS_TEST_UNIT=0` and
  `IMP_ZFS_E2E_SUITES=lifecycle,checkpoints,disks,sleep,backups,boot-templates`.
- **`go`** runs `gofmt -l`, `go vet ./...` and `scripts/test-go.sh` in `agent/`, with
  `GO_TEST_JSONFILE` under `runner.temp`, and uploads that JSON as `go-test-results`, whether the
  tests pass or fail.

## Stand-ins by boundary

Paths are under `packages/daemon/src/` unless they start with `test/`, `scripts/` or `packages/`.

| Boundary                     | Stand-in                                                                                           | What it replaces                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| VMM                          | `test-utils/build-stub-vmm.ts` (`buildStubVmm`)                                                    | The `VmRunner`, with `ok`, `fail`, `die`, `hang` per step                          |
| impd                         | `create-impd.ts` (`createImpd`) with stubs as its deps                                             | The host: see Booting impd below                                                   |
| Governed imps                | `imps/test-imps.ts` (`setupImpTest`, `createImpTest`, `buildTestApp`)                              | A shim over createImpd's parts, without its start steps                            |
| Firecracker API              | `Bun.serve({ unix })` (1); a Bun script (2)                                                        | Firecracker's HTTP API on its socket                                               |
| Firecracker process          | `bash` run under the name `firecracker` (3)                                                        | A process whose cmdline matches Firecracker's                                      |
| Guest agent                  | `test-utils/start-stub-agent.ts` (`startStubAgent`)                                                | The agent on the vsock socket: CONNECT and frames                                  |
| Builder guest                | `test-utils/build-stub-guest.ts` (`buildStubGuest`)                                                | A builder's agent: output and exit per exec                                        |
| zfs                          | `test-utils/build-stub-zfs.ts` (`buildStubZfs`)                                                    | `zfs`, send and receive, and the mount table                                       |
| FIEMAP                       | `test-utils/build-stub-fiemap.ts` (`buildStubFiemap`)                                              | `readFileExtents` of the XFS backend: extents, cuts, failures, removals per path   |
| Loop device host             | Temp dirs as `procDir` and `sysDir` (`storage/loop-backing-file.ts`)                               | `/proc/self/mountinfo` and a loop device's `backing_file` in `/sys`                |
| Docker engine                | `test-utils/start-stub-docker-engine.ts` (4)                                                       | The engine API on its unix socket                                                  |
| Docker CLI                   | `test-utils/build-stub-docker-cli.ts` (`buildStubDockerCli`)                                       | The host's `docker` binary, first on `PATH`                                        |
| Image builder                | `test-utils/build-stub-image-builder.ts` (`buildStubImageBuilder`)                                 | A builder's engine: pull, pin, build, create and export                            |
| mkfs.ext4                    | `test-utils/build-stub-image-mkfs.ts` (`buildStubImageMkfs`)                                       | `mkfs.ext4` held until the test releases or fails it                               |
| Silent build engine          | `test-utils/start-stub-silent-build-engine.ts` (4)                                                 | An engine silent through a build's quiet RUN step                                  |
| CLIs a script calls          | `scripts/test-utils/create-stub-bin.ts` (7)                                                        | `docker`, `gh`, `systemctl`, `curl`, `ip`, `mv`, `stat`                            |
| Docker for upgrade           | `scripts/test-utils/build-stub-host-docker.ts`                                                     | The docker that `deploy/upgrade.sh` drives on a host                               |
| Docker for dev.sh            | `scripts/test-utils/build-stub-dev-docker.ts`                                                      | The images, labels and containers `dev.sh prune` reads                             |
| Registry for base            | `scripts/test-utils/build-stub-registry-docker.ts`                                                 | `docker buildx imagetools inspect` in the release Plan step                        |
| impd for the client          | `packages/client/smoke/run-stub-impd.ts`                                                           | impd's app on loopback, run by `check-client-runtimes.sh`                          |
| nft                          | `test-utils/build-stub-nft.ts` (`buildStubNft`) (10)                                               | `nft` from the egress service                                                      |
| nft binary                   | `test-utils/create-stub-nft-bin.ts` (`createStubNftBin`)                                           | The `nft` that `createNftRunner` spawns                                            |
| Upstream DNS                 | `test-utils/start-stub-dns-upstream.ts`                                                            | An IMP_DNS server over UDP and TCP, with chosen faults                             |
| Egress for resolver          | `test-utils/build-stub-egress-service.ts`                                                          | The egress service as `createQueryHandler`'s deps                                  |
| Host routes                  | `test-utils/build-stub-host-routes.ts` (`buildStubHostRoutes`)                                     | The container's links and default routes egress reads                              |
| Tunnel far end               | `test-utils/start-stub-echo-server.ts` (`startStubEchoServer`)                                     | A host a broker tunnel dials: it echoes and holds open                             |
| ip and sysctl                | `buildFakeIp` in `net/tap-devices.test.ts`                                                         | `ip` and `sysctl -n`, as `createTapDevices`'s `run`                                |
| mount                        | A `run` with a mount table in `vmm/jail.test.ts`                                                   | `mount` and `umount` for the jailer                                                |
| cgroups and `/proc`          | Temp dirs as `root` and `procRoot` (5)                                                             | The cgroup tree and `/proc`                                                        |
| cgroups for impd             | `test-utils/build-stub-cpu-cgroups.ts`                                                             | `CpuCgroups`: an in-memory tree that records each change                           |
| restic                       | `test-utils/build-stub-restic.ts` (`buildStubRestic`)                                              | `Restic` over a directory: snapshots in `snapshots.json`, which two hosts share    |
| restic's process             | `test-utils/build-stub-restic-runner.ts`, `build-stub-restic-lock-runner.ts`                       | `createRestic`'s runner: queued results; restic's lock rule, held until stopped    |
| ZFS for moves                | `test-utils/build-stub-zfs-storage.ts` (`buildStubZfsStorage`)                                     | An impd's ZFS backend on `buildStubZfs`, as a harness's `createStorage`            |
| Storage faults               | `test-utils/build-stub-storage-faults.ts` (`buildStubStorageFaults`)                               | A backend whose next `openMoveSource` rejects                                      |
| Older move target            | `test-utils/build-stub-older-move-target.ts` (`buildStubOlderMoveTarget`)                          | A target whose offer reply lacks a `keeps*` field, as a `setupMoveHosts` hook      |
| Switched storage             | `test-utils/build-stub-switched-storage-target.ts`                                                 | A target whose offer reply names another storage backend                           |
| Lost commits                 | `test-utils/build-stub-dropped-commit.ts` (`buildStubDroppedCommit`)                               | A network that drops a move's first commits, or their answers                      |
| lseek and fstat              | `test-utils/build-stub-lseek.ts`                                                                   | `SEEK_DATA`/`SEEK_HOLE` over chosen extents, for `findDataBlocks`                  |
| Move stream faults           | `test-utils/build-stub-move-stream-rewrite.ts`                                                     | A hook that rewrites the frames of a move's first stream part                      |
| Part pipe timer              | `test-utils/build-stub-timer.ts` (`buildStubTimer`)                                                | `createPartPipe`'s `PartTimer`: a clock and timers that move only on `advance`     |
| Imp guest agent              | `test-utils/build-stub-exec-guest.ts`                                                              | An imp's agent for the MCP tools: files and shell verbs                            |
| Session agent                | `test-utils/start-stub-session-agent.ts` (`startStubSessionAgent`)                                 | An agent that runs, takes over and resumes sessions, and answers `activity`        |
| Attach agent                 | `test-utils/start-stub-attach-agent.ts` (`startStubAttachAgent`)                                   | A 0.15.0 agent: a ping with a boot id, then scripted session replies               |
| Disk clone and grow          | `test-utils/build-stub-disk-tools.ts` (`buildStubDiskTools`)                                       | `createImpTest`'s `cloneDisk` and `growFilesystem`: fail, land empty, or hold      |
| Imp exec agent               | `test-utils/start-stub-exec-agent.ts` (`startStubExecAgent`)                                       | An imp's agent on its vsock socket, driving `buildStubExecGuest`                   |
| tailscale CLI                | `test-utils/build-stub-tailscale.ts` (`buildStubTailscale`)                                        | `tailscale whois --json` and `status --json`, as `runWhois`'s `run`                |
| MCP upstream                 | `test-utils/build-stub-mcp-transport.ts`                                                           | The `HttpTransport` to an imp's MCP server: calls held open until ended            |
| tailscale whois              | A `whois` function passed to `createTailnetIdentities`                                             | `tailscale whois --json` (`runWhois`)                                              |
| Connector upstreams          | `test-utils/start-stub-broker-tls-upstream.ts` (6); `test/e2e/lib/start-stub-upstream.ts`          | github.com, api.github.com, an OAuth token endpoint                                |
| Git over SSH                 | `test/e2e/lib/start-stub-git-ssh-server.ts` (`startStubGitSshServer`)                              | A forge's SSH git: one allowed key, push to `repo.git` only                        |
| Cloudflare API               | A `server.use` MSW handler in `https/acme/acme-issuer.pebble.ts`                                   | `api.cloudflare.com/client/v4`                                                     |
| Host networks                | `test-utils/build-stub-public-network.ts` (8)                                                      | Guests on taps, an uplink to the internet, a tailnet peer                          |
| GitHub releases              | `packages/test-utils/src/start-stub-github-releases.ts` (9)                                        | The releases pages `install.sh` fetches with curl                                  |
| gh and uname                 | `packages/test-utils/src/create-stub-gh-attestation.ts`, `create-stub-uname.ts` (9)                | `gh auth status`, `gh attestation verify`, `uname -s -m`                           |
| shasum and PATH              | `packages/test-utils/src/create-stub-shasum.ts`, `create-command-links.ts` (9)                     | macOS's `shasum -a 256`; a PATH of only the linked commands                        |
| Client's exec agent          | `packages/client/src/test-utils/build-stub-exec-agent.ts`                                          | An imp's agent for exec and attach, scripted by argv                               |
| Client's fwd agent           | `packages/client/src/test-utils/build-stub-forward-agent.ts`                                       | An imp's agent for reverse forwards: listen and accept                             |
| impd's /exec socket          | `packages/client/src/test-utils/start-stub-impd-socket.ts`                                         | Protocol faults a real impd never sends                                            |
| Host engine for client       | `packages/client/src/test-utils/start-stub-docker-engine.ts`                                       | Docker's POST /build on a unix socket                                              |
| Docker CLI for client        | `packages/client/src/test-utils/create-stub-docker-bin.ts`                                         | inspect, create, export and rm of the images a test names                          |
| impd before the build stream | `packages/client/src/test-utils/build-stub-impd-before-build-stream.ts`                            | Real impd, with no Accept read on POST /images/build                               |
| A newer impd                 | `packages/client/src/test-utils/build-stub-impd-with-new-reason.ts`                                | Real impd's events, with an ImpChanged reason it lacks                             |
| impd before 0.30.0           | `packages/client/src/test-utils/build-stub-impd-before-exec-require.ts`                            | Real impd's answers, with system.info lacking execRequire                          |
| OAuth token endpoint         | `test-utils/build-stub-broker-token-endpoint.ts` (11)                                              | A token endpoint: queued answers per refresh token                                 |
| Rule upstreams               | Per-test MSW handlers in `broker/broker.test.ts`; `test-utils/start-stub-broker-plain-upstream.ts` | A secret rule's own `upstream` origin; the plain listener for the Host on the wire |
| Guest's HTTPS tools          | `test-utils/build-stub-broker-guest.ts` (`curl`)                                                   | A guest's client through the broker's front port                                   |
| Guest's CONNECT              | `test-utils/start-stub-broker-tunnel.ts`                                                           | A raw CONNECT a guest holds open through the front port                            |
| Tunnel targets               | `test-utils/start-stub-broker-reply-target.ts`, `start-stub-broker-hold-target.ts`                 | The far end of a plain tunnel: a reply after the request, or a held socket         |
| Guest's raw socket           | `test-utils/start-stub-broker-guest-socket.ts`                                                     | A guest's socket to the front port, read until it closes                           |

1. `vmm/firecracker-client.test.ts`, `vmm/vm-runner.test.ts`.
2. `vmm/template-vm.test.ts` spawns it as the VMM process.
3. `vmm/firecracker-process.test.ts`, `vmm/vm-runner.test.ts`.
4. `startStubDockerEngine`: a `Bun.serve({ unix })` in the test's temp dir, over `@msw/data`
   collections of containers and images; a call it does not model gets a 500 that names it and lands
   in `unexpected`, which each test that uses it asserts empty. It reads image names as the engine
   does (`busybox` is `docker.io/library/busybox:latest`). MSW's passthrough drops `unix`, so the
   engine stays a server. `docker-proxy/proxy.test.ts` serves the proxy on a unix socket as its main
   does. `test-utils/start-stub-silent-build-engine.ts` is a raw socket engine that stays silent
   through a build, for `images/docker-build.test.ts`'s idle-limit test: a child Bun with
   `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1` runs `test-utils/run-idle-limited-docker-build.ts`, whose
   unprotected fetch starts once both builds are silent (`started`) and expires after about 8 s.
5. Options of `vmm/cpu-cgroups.ts`, and the `procRoot` parameter of `vmm/process-owner.ts`.
6. Used by `broker/broker.test.ts`, `broker/broker-oauth.test.ts`, `broker/forward-request.test.ts`
   and `broker/oauth-refresher.test.ts`: real TLS on loopback with a CA of its own, since the
   broker's verification of the upstream and the guest's view of an untrusted certificate are under
   test. Like the other broker stand-ins, it takes the caller's stack and defers its release into
   it.
7. The shell tests in `scripts/` and `deploy/`: a stub on a temp `PATH` logs each call to one file
   and answers from a bash script the test gives it. `run-sourced-function.ts` beside it calls a
   function of a sourced script with only `PATH` and the variables a test passes.
8. Bash that `egress/egress-ruleset.host.test.ts` runs in a mount and network namespace.
9. `install.test.ts` at the repo root, which runs `install.sh` with `sh`.
10. `setupImpTest`'s default `runNft` still records scripts for the suites that use it.
11. An MSW handler a test adds with `server.use`; an unissued refresh token gets `invalid_grant`.

The mcp package's tests boot impd's real app with `createImpd` and reach it through the real
`@zgeoff/imp-client`, whose `fetch` is `impd.api.app.handle`. A test that needs a tool call to wait
holds impd's read of the imps with `buildQueryGate`. One stand-in models an impd release from before
the fork's grant report: `packages/mcp/src/test-utils/build-stub-older-impd-fetch.ts`
(`buildStubOlderImpdFetch`) takes `grantsNotCopied` and `grantsError` out of the real `imps.fork`
answer. The progress and keepalive timers of `createMcpServer` and `createHttpTransport` take a
`repeat`, and the tests pass `packages/mcp/src/test-utils/build-stub-repeat.ts` (`buildStubRepeat`),
which ticks only when the test says so. A tool call's deadline (`timeoutSeconds`) and kill grace
take `createMcpServer`'s `after`, `setTimeout` by default, and the tests pass
`packages/mcp/src/test-utils/build-stub-after.ts` (`buildStubAfter`), which fires only when the test
says so.

In the `mcp/*.test.ts` files, an exec through impd's real app reaches the guest through
`test-utils/start-stub-exec-agent.ts` (`startStubExecAgent`) on the imp's vsock path, which runs
each command on `buildStubExecGuest`; the agent keeps its socket through a sleep or stop and wake.
The tool tests drive `createMcpServer` in process. `exec-tool.test.ts` passes `buildStubRepeat` and
`buildStubAfter` as its timers, except one timeout test that keeps the default timers and waits its
one-second deadline. `imp mcp` runs as a subprocess against impd's app on a loopback port.

The broker takes `beforeGrantWrite` (through `createImpd`'s `broker` deps), which runs between a
grant call's access check and its transaction, as `afterRuleRead` runs between a request's rule read
and its value read; `build-app-grants.test.ts` and `build-app-token-update.test.ts` act there.

impd's API listens with `buildApiListenOptions(config, idleTimeoutS)` (`api-listen-options.ts`),
whose idle timeout defaults to Elysia's 30 seconds. `mcp/mcp-endpoint.test.ts` listens with 1
second, which Bun 1.4.2 enforces about 4 seconds after the last byte. On Bun 1.4.2 the idle timeout
ends a request without a body, or a streamed answer that falls silent; it never ends a request that
sent a body and still waits for its answer.

The cli package's tests that talk to impd boot it with `createImpd` in their file's `setupTest()`
and spawn the real binary (`packages/cli/src/test-utils/start-cli.ts`) against its app on a loopback
port; the parser, formatter, config and other pure tests boot nothing. The stand-ins in
`packages/cli/src/test-utils/` sit in front of the real app or replace only a transport:

- `start-stub-older-impd.ts` (over `build-stub-older-impd-fetch.ts`): an older release. It drops
  named feature flags or the whole features object from `system.info`, sends a procedure the release
  lacked to impd's own not-found, drops named events of a stream, and records each procedure it
  forwards.
- `start-stub-newer-impd.ts` (over `build-stub-newer-impd-fetch.ts`): a newer release that adds
  named fields to a procedure's answer.
- `start-stub-info-fault-impd.ts`: drops the connection of each `system.info` call and forwards the
  rest.
- `start-stub-tunnel-fault-proxy.ts`: forwards `/tunnel` sockets and sends one a message the
  protocol does not know.
- `start-stub-silent-host.ts`: takes requests and never answers.
- `start-stub-prefix-proxy.ts`: serves the real app under a path prefix, HTTP and WebSocket.
- `build-stub-exec-peer.ts`: an in-memory `/exec` socket that sends the literal frames a test
  scripts, for protocol faults impd never sends; `exec-client.ts` takes it through `io.connect` and
  `cp/open-tool-exec.ts` through `connect`.
- `start-stub-service-agent.ts`: the guest agent's services API on the imp's vsock path.
- `start-warm-move-hosts.ts`: `createMoveHosts(stack, { isShared: true })` with both apps on
  loopback, because two impds in one process cannot share the data dir a warm move needs.

The client package's tests boot impd through `createImpd` in each file's `setupTest()`, with the
client stub agents on the imp's vsock socket. Image builds and adds run with
`IMP_BUILD_ISOLATION=host` against `packages/client/src/test-utils/start-stub-docker-engine.ts` (at
`DOCKER_HOST`) and `create-stub-docker-bin.ts` (first on `PATH` through `updateEnv`), with the real
`tar` and `mkfs.ext4`; no builder imp runs. An older or newer impd is a `build-stub-impd-*` stand-in
in front of the real app, at `http://impd.test/` through MSW. Answers impd never sends (a proxy's
502, a cut stream, bad frames) go to the pure cores: `read-build-answer.ts` on literal responses,
and `start-stub-impd-socket.ts` for `/exec`. Over a socket, Bun's fetch replaces the Content-Length
of a Blob's stream with the Blob's real size, but keeps the one a caller sets on a `ReadableStream`
it made, so `build-image.test.ts` sends a declared size with a hand-made stream to impd's real
listener. That listener takes `main.ts`'s `maxRequestBodySize`, since Bun's own 128 MiB default
answers a bare 413 before the build route can. The keepalive tests there boot impd with a
`keepaliveMs` of 500 and run the client in a Bun child with `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1`, which
Bun's coarse timer turns into a deadline of about 8 s (measured 7.99 s from the engine's hold, four
runs); the engine holds the build silent for 28 keepalives, about 13.5 s. A streamed build outlasts
the deadline; through `build-stub-impd-before-build-stream.ts` the client gives up at it, and impd
then stops the build on the engine (the engine's `signals` record it), so no image lands. The stub
engine serves with `idleTimeout: 0` behind a type assertion, as `docker-proxy/main.ts` does: Bun's
types leave the option off unix servers, its 10 s default closes a silent build after 10 to 12 s,
and `server.timeout(request, 0)` does not lift it once the answer has started. The 13.5 s hold fails
without it. Its image factory is `packages/client/src/test-utils/build-mock-image.ts`
(`buildMockImage`).

Host networking runs the real tools: `host/scripts/setup-net.host.test.ts` runs
`host/scripts/setup-net.sh` with `iptables`, and `egress/egress-ruleset.host.test.ts` applies impd's
ruleset with `nft`, each in a fresh network namespace through `test-utils/run-in-netns.ts`.

The Pebble suite, `https/acme/acme-issuer.pebble.ts`, starts its own Pebble and challtestsrv for
each test through `test/e2e/lib/pebble.ts` (under a second to start, about a second to stop), named
`imp-acme-it-<pid>-<random>`, with a cert store in a temp dir. `bun run test:pebble` first pulls the
pinned images (`PEBBLE_IMAGES` in that helper) with `scripts/pull-pebble-images.ts`, so no test pays
for a pull.

### Booting impd

`packages/daemon/src/create-impd.ts` holds impd's wiring, which `main.ts` and the tests share.
`createImpd(config, deps)` builds every service and runs the boot steps in `main.ts`'s order:
storage start, firewall start, VM re-adoption, leftover and drive cleanup, move recovery. It opens
no port: `main.ts` then listens, starts the tickers and owns the stop. `deps` takes the database,
the root token, an unstarted storage backend and the system files, and optional stand-ins for each
boundary (`vms`, `runCommand`, `taps`, `cgroups`, `broker`, `egress`, `imps`, `images`,
`readDiskSpace`, `readIdentity`, `resolveIpv6`, `readTailscale`, `whois`, `freezer`, `oauthKey`,
`now`, `log`, and `keepaliveMs`, the gap between a streamed image call's progress events, 15 s by
default); `now` reaches leases, the RAM governor and memory control, egress, the broker (its CA and
leaves, the leaf renewal check, its route caches, OAuth refreshes), tokens, OAuth, the audit log,
moves and the API. It does not reach `buildTailnetNames`' services API, the template service's
timings (`performance.now`), the disk usage cache, backups or the builders' engine wait, which stay
on the wall clock: a known gap. A field left out takes the host's real one. Its parts
(`buildImpdStorage`, `createImpdBroker`, `buildImpdEgress`, `startGovernedImps`, `loadImpdAccess`,
`buildImpdServices`, `createImpdMoves`, `buildImpdApp`) are exported for `createImpTest`, which
wires them without the start steps into a caller's stack; `setupImpTest` wraps it with its own
stack, and the client smoke's `run-stub-impd.ts` runs it outside a test.
`packages/daemon/src/create-impd.test.ts` boots it whole on the stubs. The egress resolver binds
`IMP_EGRESS_DNS_PORT` on every address, so a test takes a free one from
`test-utils/find-free-ports.ts`. Egress's `repeat` dep runs its sweep (`startInterval` by default),
so a test fires a sweep by calling the function it was handed. A `createImpd` test whose storage
clones with `copyFile` sets `defaultDiskBytes` to 0, or each disk is a 32 GiB sparse file and a
checkpoint's copy takes minutes.

`moves/test-moves.ts` (tested in `test-moves.test.ts`) builds two impds on `createImpTest`. Its
`hook` gets each request the source sends, a `forward(replacement?)` to the target's move routes,
and the target's `advance` and the source's client; `waitForMove` polls with `waitFor`.
`createZfsUbuntuImage` puts the `ubuntu` image on a ZFS host. The stub VMM numbers VMs from 1 on
each host, so boot ids of two hosts collide. Time seams for moves: `createPartPipe(waitMs, timer)`
takes a `PartTimer`, `createIdleLoop` takes `now`, and `createCheckpointService` takes `random` for
its ids; each defaults to the wall clock or `Math.random`. `runMigrationsTo(db, name, migrations)`
takes a test's own migrations, so a test can run one that fails; it defaults to impd's. The move
sender's `waitForRecovery()` settles once the background recovery that `recover` started has run, so
a test waits for it before teardown.

## Connectors

impd's broker resolves each granted host through `broker/test-upstreams.ts`. When
`IMP_BROKER_TEST_UPSTREAMS` names a file, the broker reads it on each request (cached by mtime), and
logs each load:

```json
{ "ca": "-----BEGIN CERTIFICATE-----…", "upstreams": { "github.com": "https://172.17.0.1:9443" } }
```

Each upstream must be an `https` URL. A listed host goes to that origin, and the forward trusts `ca`
next to `node:tls` `rootCertificates`, so certificate verification stays on. A missing or invalid
file leaves every host on its real origin.

- **Daemon tests.** `broker.test.ts` and `broker-oauth.test.ts` boot impd with `createImpd` and pass
  the file through `loadConfig({ IMP_BROKER_TEST_UPSTREAMS })`, with `IMP_SUBNET` `127.0.0.0/16` so
  a loopback address stands for a guest. The OAuth token endpoint and a rule's plain-HTTP upstream
  are MSW handlers, not entries in the file.
- **End to end.** `scripts/dev.sh` sets
  `IMP_BROKER_TEST_UPSTREAMS=/data/broker-test-upstreams.json`. The `connectors` suite starts
  `test/e2e/lib/start-stub-upstream.ts` (`startStubUpstream`, tested in
  `start-stub-upstream.test.ts`) on the container's gateway address. The stub serves git smart HTTP
  behind Basic auth, checks the bearer token, and runs an OAuth token endpoint, over a CA and leaf
  that `openssl` makes per run. The suite writes `<IMP_DEV_DATA>/broker-test-upstreams.json` with
  the stub's `caPem` and origin, and removes it at the end; the harness's baseline reset removes it
  too. The `moves` suite writes the same file into the target host's data dir, and removes it from
  both hosts.
- **Guest trust.** The guest trusts the broker's own CA through impd's CA bundle step, as
  `docs/guides/connectors.md` describes; the test-upstreams `ca` stays on the host side.

## Host requirements and safety

| Run                        | Root         | KVM | Docker | Tailnet key | Public internet       |
| -------------------------- | ------------ | --- | ------ | ----------- | --------------------- |
| `bun test`, dashboard      | no           | no  | (5)    | no          | no                    |
| Host networking            | root, or (1) | no  | no     | no          | no                    |
| `scripts/test-zfs.sh`      | yes          | no  | no     | no          | no                    |
| Build disk hold            | sudo (2)     | no  | no     | no          | no                    |
| `test:pebble`              | no           | no  | yes    | no          | pinned ghcr.io images |
| End to end                 | sudo (3)     | yes | yes    | (4)         | yes                   |
| `scripts/zfs-host-test.sh` | sudo         | yes | yes    | no          | yes                   |

1. Unprivileged user namespaces.
2. To mount the small filesystem.
3. Passwordless, for the `registry` suite.
4. For `tailscale` and `moves-tailnet`.
5. Optional: `packages/cli/src/image/run-image-build.docker.test.ts` runs the real `docker buildx`
   and skips when it is missing.

- `IMP_HOST_TESTS=required` makes the `canUnshare` probe (`packages/daemon/src/test-utils/`) of each
  `*.host.test.ts` test true, so a missing tool or namespace fails the test instead of skipping it.
  `build-unshare.ts` there adds a user namespace (`-r`) only when the uid is not 0.
  `deploy/bootstrap.test.ts`'s `nft -c` check of the rendered firewall reads it too; plain
  `bun test` skips that check where `unshare -rn nft` fails.
- `scripts/check-kvm.sh` checks for `vmx` or `svm` and that `/dev/kvm` opens for read and write. The
  dev container gets `/dev/kvm` and `/dev/net/tun` from `deploy/imp-host.args.json`, plus
  `/dev/loop-control` and loop devices for its XFS file.
- The end-to-end harness drives the container that `scripts/dev.sh` starts: `IMP_DEV_NAME` (default
  `imp-dev`), with data in `IMP_DEV_DATA` (default `.data/dev`, a sparse `imp.xfs`) and the API on
  `localhost:7070` plus `IMP_DEV_PORT_OFFSET`. `test/e2e/lib/instance.ts` takes the API URL from
  `IMP_URL` when it is set, and throws when `IMP_DEV_PORT_OFFSET` is set without `IMP_DEV_NAME`. The
  token comes from `scripts/dev.sh token`, so it is the dev instance's.
- `--clean` logs the instance out of the tailnet, removes the container, and wipes its data dir and
  the moves host's. `main.ts` refuses to wipe a data dir that is outside `.data/` and holds no
  `imp.xfs`.
- Worktrees run instances side by side with their own `IMP_DEV_NAME` and `IMP_DEV_PORT_OFFSET`; each
  checkout's host image is tagged `imp-host:dev-<dir>-<hash>`.
- One impd runs one suite at a time: the harness never runs suites side by side against one
  instance, and each `--group` needs its own instance, and so its own KVM host or its own
  `IMP_DEV_NAME` and `IMP_DEV_PORT_OFFSET`.
- The `registry` suite trusts its registry's certificate through Docker's fixed per-registry path,
  `/etc/docker/certs.d/<name>:<port>`, with `createRegistryTrust` in
  `test/e2e/lib/create-registry-trust.ts`. It makes that directory with `sudo mkdir` and no
  `--parents`, so a directory already there is refused untouched; a failed owner-file write or
  certificate copy removes the directory again; and its release removes only that directory, once,
  never `/etc/docker/certs.d` itself. `create-registry-trust.test.ts` runs it in a temp root with no
  sudo (`certsRoot`, `asRoot`). Each test takes the trust itself and releases it with
  `onTestFinished` right after, since `--bail` skips `afterAll` once any test fails. Taking it
  writes an owner file, `imp-e2e-owner` (the process's pid and its start time from
  `/proc/<pid>/stat`), into the directory; when this process's start time cannot be read it makes
  nothing, since no later run could prove the directory. A process killed mid-test still leaves the
  directory, so each acquisition first runs `removeStaleRegistryTrusts` for the registry's host: it
  removes a `<host>:*` directory only when its owner file parses and its pid's start time is not the
  recorded one (the process is gone, or its pid now names another). A directory with no owner file,
  one that does not parse, one that records no start time, and one whose owner still runs all stay,
  and `mkdir` then refuses the last three if they hold the same port. The suite still removes stale
  registry containers by the name pattern `e2e-reg-registry-`.
