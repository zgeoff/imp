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

| Run                     | Command                                                             | Needs                                              |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| Unit and package tests  | `bun test` at the root                                              | Nothing beyond Bun; the gated files below skip     |
| Dashboard components    | `bun run test:dashboard`                                            | Nothing beyond Bun                                 |
| End to end              | `scripts/test-e2e.sh`                                               | KVM, Docker; some suites need more (below)         |
| Host networking         | `sudo env "PATH=$PATH" IMP_HOST_TESTS=required bun test test/host/` | Root or unprivileged namespaces, `nft`, `iptables` |
| ZFS on a real pool      | `sudo env "PATH=$PATH" scripts/test-zfs.sh`                         | Root, the zfs module, `zpool`                      |
| ZFS on a host, with VMs | `scripts/zfs-host-test.sh`                                          | sudo, Docker, KVM, the zfs module                  |
| Build disk hold         | `IMP_TEST_SMALL_FS=<dir> bun test <file> -t 'small filesystem'`     | A small filesystem mounted at `<dir>`              |
| ACME issuer             | `bun run test:pebble`                                               | Docker                                             |
| Docker idle             | `bun run test:slow`                                                 | Nothing beyond Bun; about 6.5 minutes              |

The build disk hold's `<file>` is `packages/daemon/src/images/isolated-build.test.ts`; its
small-filesystem tests skip unless `IMP_TEST_SMALL_FS` names a directory.

The root `bunfig.toml`'s `pathIgnorePatterns` skips `packages/dashboard/**`. The dashboard's own
`bunfig.toml` preloads `packages/dashboard/test-setup.ts`, which registers a DOM, so its tests run
from the package.

The root preload is `packages/test-utils/src/preload.ts`, ahead of `@zgeoff/bun-test-extended`;
`packages/test-utils/bunfig.toml` repeats it for a run from that package. It seeds faker, restores
every `updateEnv` override after each test, and runs one MSW server
(`packages/test-utils/src/mock-server.ts`) for the whole run with `onUnhandledRequest: 'error'`. The
server intercepts `fetch` only; `node:http` clients and WebSockets stay native. While it listens,
the global `fetch` sends a request to a loopback host or over a unix socket to the native fetch
(`route-fetch.ts`), and every other request to MSW. The end-to-end suites run with
`test/e2e/bunfig.toml`, whose preload (`preload-e2e.ts`) restores env overrides and seeds faker,
with no MSW server. `updateEnv`, `invariant` and `waitFor` live in `packages/test-utils/src`.

Plain `bun test` does not match `*.e2e.ts`, `*.pebble.ts`, or `*.slow.ts`; each of those runs only
when its `./` path is given. The `*.real.test.ts` files and the small-filesystem tests load in plain
`bun test` and skip unless their variables are set. `test/host/` loads too, and skips where its
namespace probe fails.

## End-to-end harness

`scripts/test-e2e.sh` runs `test/e2e/main.ts`. The harness:

1. Brings the dev instance down and up with `scripts/dev.sh` (`--reuse` keeps a running one), then
   checks the container's privileges against `deploy/` with `test/e2e/lib/privileges.ts`.
2. Reads the API token with `scripts/dev.sh token` and sets `IMP_TOKEN` and `IMP_HOST_IMAGE`.
3. Builds the fixture images the selected suites list and impd does not have yet.
4. Runs each suite as its own process,
   `bun test --config=test/e2e/bunfig.toml --bail --timeout 3600000 ./test/e2e/suites/<name>.e2e.ts`,
   in the order of `SUITES` in `test/e2e/lib/suites.ts`.
5. After each suite, fails it when the impd log shows a boot-template fallback (the `chaos` suite
   may cause one), and on a failure removes the imps with the suite's prefix (`e2e-<abbr>-`).
6. Writes `.cache/e2e/results.json`, merging the metrics suites append to `.cache/e2e/metrics.jsonl`
   (`E2E_METRICS_FILE`).

A suite file also runs alone against an instance that is up:
`bun test --config=test/e2e/bunfig.toml ./test/e2e/suites/sleep.e2e.ts`.
`test/e2e/lib/setup-suite.ts` then removes the suite's leftover imps and builds its missing images.

Flags: `--only <suites or sets>`, `--clean`, `--reuse`, `--keep`; `--help` lists the suites. The
sets live in `SUITE_SETS`: `acceptance` (the default) is every suite, and `fast` is the CI subset.
`main.ts` sets `E2E_ACCEPTANCE=1` when the run includes `acceptance`; tailnet suites then fail
instead of skipping, and the timing limits fail the run instead of warning.

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

`main.ts` sets `E2E_SUITES`, `E2E_KEEP`, `E2E_ACCEPTANCE`, and `E2E_METRICS_FILE` for each suite
process. Suites that reboot the instance pass impd settings through `process.env`, which
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

The `test/e2e/lib/*.test.ts` unit tests run in plain `bun test` and boot nothing.

## ZFS

- **The fake.** `packages/daemon/src/test-utils/build-stub-zfs.ts` (`createFakeZfs`) answers impd's
  `zfs` argv (`run`), send and receive streams (`streams`), and `/proc/self/mounts` (`readMounts`)
  in memory. It models datasets, snapshots, clones, promote, deferred destroy, legacy mounts, and
  txg-based `creation`, with fixed space numbers. It exposes `blockBefore`, `failOnce`,
  `crashBefore`, and `restart`. `zfs-backend.ts` takes it through those injected deps.
- **The real-pool tests.** `zfs-backend.real.test.ts`, `zfs-move.real.test.ts`, and
  `zfs-move-flow.real.test.ts` skip unless `IMP_TEST_ZFS_ROOT` (a dataset) and `IMP_TEST_ZFS_DIR`
  (its mount dir) are both set.
- **`scripts/test-zfs.sh`** runs as root. It makes a sparse-file pool `imptest<pid>` of
  `IMP_ZFS_TEST_GIB` (default 4) under `IMP_ZFS_TEST_DIR` (default a new temp dir), mounts
  `<pool>/imp` with a legacy mount, runs `bun test packages/daemon/src/storage/zfs` with both gates
  set, and destroys the pool on exit. The run includes the fake-backed tests in that folder.
- **`scripts/zfs-host-test.sh`** runs `test-zfs.sh` (unless `IMP_ZFS_TEST_UNIT=0`), then starts a
  dev instance `imp-zfs` (port offset `IMP_DEV_PORT_OFFSET`, default 300) with
  `IMP_STORAGE_BACKEND=zfs` on a second sparse pool of `IMP_ZFS_BENCH_GIB` (default 40), runs the
  suites in `IMP_ZFS_E2E_SUITES` (default `checkpoints,sleep`), and writes `<dir>/summary.txt`.

## CI

`.github/workflows/ci.yml`:

- **`checks`** runs `bun test`; the build disk hold on a 4 GiB loop-mounted XFS that it formats,
  mounts with sudo, and names in `IMP_TEST_SMALL_FS`; `bun run test:pebble`; and
  `bun run test:dashboard`.
- **`e2e`** (a required check) runs `scripts/check-kvm.sh` first, hands the cpu cgroup controller to
  containers, turns KSM on, picks `/mnt/imp-e2e` or `.data/ci` as `IMP_DEV_DATA`, runs the host
  networking tests as root with `IMP_HOST_TESTS=required`, builds inputs with
  `.github/actions/e2e-build`, adds `imp-e2e-registry.test` to `/etc/hosts`, and runs
  `scripts/test-e2e.sh --only fast` with `E2E_RAM_BUDGET_MIB=4096` and no Tailscale key. It uploads
  `.cache/e2e/` and `packages/dashboard/.test-results/`.
- **`zfs`** (not required) runs `scripts/check-kvm.sh`, installs ZFS, runs `scripts/test-zfs.sh`
  with `IMP_ZFS_TEST_DIR` blank, then `scripts/zfs-host-test.sh` with `IMP_ZFS_TEST_UNIT=0` and
  `IMP_ZFS_E2E_SUITES=lifecycle,checkpoints,disks,sleep,backups,boot-templates`.
- No job runs `bun run test:slow`.

## Stand-ins by boundary

Paths are under `packages/daemon/src/` unless they start with `test/`.

| Boundary            | Stand-in                                                     | What it replaces                                          |
| ------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| VMM                 | `test-utils/build-stub-vmm.ts` (`buildFakeVmm`)              | The `VmRunner`, with `ok`, `fail`, `die`, `hang` per step |
| impd                | `create-impd.ts` (`createImpd`) with stubs as its deps       | The host: see Booting impd below                          |
| Governed imps       | `imps/test-imps.ts` (`setupImpTest`, `buildTestApp`)         | A shim over createImpd's parts, without its start steps   |
| Firecracker API     | `Bun.serve({ unix })` (1); a Bun script (2)                  | Firecracker's HTTP API on its socket                      |
| Firecracker process | `bash` run under the name `firecracker` (3)                  | A process whose cmdline matches Firecracker's             |
| Guest agent         | `test-utils/start-stub-agent.ts` (`startFakeAgent`)          | The agent on the vsock socket: CONNECT and frames         |
| Builder guest       | `test-utils/build-stub-guest.ts` (`createFakeGuest`)         | A builder's agent: output and exit per exec               |
| zfs                 | `test-utils/build-stub-zfs.ts` (`createFakeZfs`)             | `zfs`, send and receive, and the mount table              |
| Docker engine       | A unix-socket server (4)                                     | The engine API                                            |
| Docker CLI          | A `docker` script on `PATH` in the images tests              | The `docker` binary                                       |
| nft                 | `setupImpTest`'s default `runNft`, which records scripts     | `nft` from the egress service                             |
| ip and sysctl       | `buildFakeIp` in `net/tap-devices.test.ts`                   | `ip` and `sysctl -n`, as `createTapDevices`'s `run`       |
| mount               | A `run` with a mount table in `vmm/jail.test.ts`             | `mount` and `umount` for the jailer                       |
| cgroups and `/proc` | Temp dirs as `root` and `procRoot` (5)                       | The cgroup tree and `/proc`                               |
| cgroups for impd    | `test-utils/build-stub-cpu-cgroups.ts`                       | `CpuCgroups`: an in-memory tree that records each change  |
| Imp guest agent     | `test-utils/build-stub-exec-guest.ts`                        | An imp's agent for the MCP tools: files and shell verbs   |
| tailscale whois     | A `whois` function passed to `createTailnetIdentities`       | `tailscale whois --json` (`runWhois`)                     |
| Connector upstreams | `Bun.serve` TLS servers (6); `test/e2e/lib/fake-upstream.ts` | github.com, api.github.com, an OAuth token endpoint       |

1. `vmm/firecracker-client.test.ts`, `vmm/vm-runner.test.ts`.
2. `vmm/template-vm.test.ts` spawns it as the VMM process.
3. `vmm/firecracker-process.test.ts`, `vmm/vm-runner.test.ts`.
4. `Bun.serve({ unix })` in `docker-proxy/proxy.test.ts` and `images/docker-build.test.ts`; a
   `node:net` server in `test/integration/docker-idle.slow.ts`.
5. Options of `vmm/cpu-cgroups.ts`, and the `procRoot` parameter of `vmm/process-owner.ts`.
6. `broker/broker.test.ts`, `broker/broker-oauth.test.ts`.

The mcp package's tests reach impd through the real `@zgeoff/imp-client` and
`packages/mcp/src/test-utils/build-stub-impd.ts` (`buildStubImpd`): an MSW handler that answers the
procedures a test implements with `implement(impContract)` through oRPC's own fetch handler. The
progress and keepalive timers of `createMcpServer` and `createHttpTransport` take a `repeat`, and
the tests pass `packages/mcp/src/test-utils/build-stub-repeat.ts` (`buildStubRepeat`), which ticks
only when the test says so.

Host networking runs the real tools: `test/host/setup-net.test.ts` runs `host/scripts/setup-net.sh`
with `iptables`, and `test/host/egress-ruleset.test.ts` applies impd's ruleset with `nft`, each in a
fresh network namespace.

### Booting impd

`packages/daemon/src/create-impd.ts` holds impd's wiring, which `main.ts` and the tests share.
`createImpd(config, deps)` builds every service and runs the boot steps in `main.ts`'s order:
storage start, firewall start, VM re-adoption, leftover and drive cleanup, move recovery. It opens
no port: `main.ts` then listens, starts the tickers and owns the stop. `deps` takes the database,
the root token, an unstarted storage backend and the system files, and optional stand-ins for each
boundary (`vms`, `taps`, `cgroups`, `broker`, `egress`, `imps`, `readDiskSpace`, `readIdentity`,
`resolveIpv6`, `readTailscale`, `whois`, `freezer`, `oauthKey`, `now`, `log`); a field left out
takes the host's real one. Its parts (`buildImpdStorage`, `createImpdBroker`, `buildImpdEgress`,
`startGovernedImps`, `loadImpdAccess`, `buildImpdServices`, `createImpdMoves`, `buildImpdApp`) are
exported for `setupImpTest`, which wires them without the start steps.
`packages/daemon/src/create-impd.test.ts` boots it whole on the stubs. The egress resolver binds
`IMP_EGRESS_DNS_PORT` on every address, so a test takes a free one from
`test-utils/find-free-ports.ts`.

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

- **Daemon tests.** `broker.test.ts` and `broker-oauth.test.ts` pass the file through
  `setupImpTest({ env: { IMP_BROKER_TEST_UPSTREAMS } })`, with `IMP_SUBNET` `127.0.0.0/16` so a
  loopback address stands for a guest.
- **End to end.** `scripts/dev.sh` sets
  `IMP_BROKER_TEST_UPSTREAMS=/data/broker-test-upstreams.json`. The `connectors` suite starts
  `test/e2e/lib/fake-upstream.ts` on the container's gateway address. The fake serves git smart HTTP
  behind Basic auth, checks the bearer token, and runs an OAuth token endpoint, over a CA and leaf
  that `openssl` makes per run. The suite writes `<IMP_DEV_DATA>/broker-test-upstreams.json` with
  the fake's `caPem` and origin, and removes it at the end. The `moves` suite writes the same file
  into the target host's data dir, and removes it from both hosts.
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
| `test:slow`                | no           | no  | no     | no          | no                    |
| End to end                 | sudo (3)     | yes | yes    | (4)         | yes                   |
| `scripts/zfs-host-test.sh` | sudo         | yes | yes    | no          | yes                   |

1. Unprivileged user namespaces.
2. To mount the small filesystem.
3. Passwordless, for the `registry` suite.
4. For `tailscale` and `moves-tailnet`.
5. Optional: `packages/cli/src/image/pack-build-context.docker.test.ts` runs the real
   `docker buildx` and skips when it is missing.

- `IMP_HOST_TESTS=required` makes the `canUnshare` probe in each `test/host/` file true, so a
  missing tool or namespace fails the tests instead of skipping them. `test/host/unshare.ts` adds a
  user namespace (`-r`) only when the uid is not 0.
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
