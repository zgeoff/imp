# Development

How to check a change before you push it, and what CI and the branch rules do with it. The
[install guide](./install.md) sets up the dev instance.

## Checks

```sh
bun run typecheck && bun run lint && bun test
bun run test:dashboard            # the dashboard's component tests, in their own run
bun run test:pebble               # the ACME issuer against Pebble in Docker
bun run format:check && bun run deadcode
bun run lint:shell                # shellcheck over scripts/, host/, kernel/, deploy/ and test/
bun run lint:docs                 # every docs/ reference in code resolves
(cd agent && gofmt -l . && go vet ./... && go test -race ./...)   # gofmt -l lists unformatted files
scripts/test-e2e.sh --clean       # end to end, from a clean state
```

`bun run lint:shell` needs shellcheck 0.11.0 on `PATH`, the version CI pins. Run the end-to-end
harness against a real instance when a change touches the lifecycle, the agent or the host;
[STATUS.md](../../STATUS.md) has the latest results.

## End-to-end tests

`scripts/test-e2e.sh` brings up the dev instance (`scripts/dev.sh`), then runs each suite in
`test/e2e/suites/` as its own `bun test` process. Every case drives impd through the `imp` CLI, the
way a user would; the dashboard suite drives it through a browser. The suites run in this order:

| Suite            | What it proves                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle`      | new, exec (stdin, stderr, exit codes, `-t`), console, egress, stop and start, rm                                                                                                                    |
| `docker`         | Docker in an `images/base` imp: run, build, a published port, egress, a cold boot                                                                                                                   |
| `images`         | `imp image build`, the image's files, ENV and WORKDIR, image rm                                                                                                                                     |
| `checkpoints`    | checkpoint, restore (running and stopped), forks, labels, deletion                                                                                                                                  |
| `disks`          | a disk past its image, grown while running, asleep and stopped; fsck after                                                                                                                          |
| `sleep`          | idle sleep, wake by HTTP, API and WebSocket, memory kept, the WebSocket relay                                                                                                                       |
| `scale`          | many imps under the RAM budget, LRU sleep, wake on request, an oversized imp refused                                                                                                                |
| `restart`        | an impd restart re-adopts VMs; stopping the instance sleeps every imp                                                                                                                               |
| `tailscale`      | an imp answers tailnet members, a tailnet request wakes it, a rule gives a member the API without a token, per-imp names                                                                            |
| `mcp`            | `imp mcp` over stdio: the guard, odd file paths, modes, a timeout's group kill                                                                                                                      |
| `sessions`       | detach, attach after sleep, takeover, idle and busy sessions, kill                                                                                                                                  |
| `offsets`        | output offsets: a gap past the ring, exact after a wake, cold-boot causes, `wake: false`                                                                                                            |
| `services`       | `imp service` and `imp logs`: a service the proxy reaches, logs and a follow across a sleep, restarts, a reboot, `--http-port`, remove                                                              |
| `ssh`            | `ssh`, `scp`, `sftp`, forwards, a VS Code-style SOCKS forward, the broker env, the firewall                                                                                                         |
| `ssh-wake`       | a login wakes a sleeping imp, a refused one does not, a connection keeps it awake                                                                                                                   |
| `ssh-agent`      | `ssh -A`: `ssh-add -l` and a signed `git push` from the imp, the socket's owner and lifetime, no key in the imp                                                                                     |
| `reverse`        | `imp proxy --reverse` and `ssh -R`: a socket and a port on this machine from the imp, refusals, sleep and wake, keep-awake                                                                          |
| `proxy`          | `imp proxy`: a busy port, a missing imp, both loopbacks, a guest-loopback server, a half-close, an old agent, the tunnel cap                                                                        |
| `proxy-wake`     | a proxy connection keeps the imp awake and wakes it; a forced sleep resets it and the next one wakes the imp                                                                                        |
| `cp`             | `imp cp` on a non-root image: owner, modes, symlinks, a 48 MiB round trip, a symlink trap, an old agent                                                                                             |
| `connectors`     | a secret through the broker: an API call, a git push, tunnels, no secret in memory                                                                                                                  |
| `dashboard`      | the web dashboard in headless Chromium: login, create, console, sleep, destroy                                                                                                                      |
| `https`          | a wildcard certificate from Pebble, an imp at `https://<name>.<domain>`, a wake                                                                                                                     |
| `tokens`         | scoped tokens: a read token cannot exec, an exec token for some imps cannot touch another, the audit log, a removed token                                                                           |
| `leases`         | two owners on one imp, `LEASED` and a forced sleep, expiry then an idle sleep, a hold; with a budget up to 2048 MiB, a refusal's names                                                              |
| `egress`         | open, box and none policies: an allow-list, a refused name, the source check, a cut flow                                                                                                            |
| `networks`       | two imps on a network across open and box, names, a peer DNS port, a reset on leave                                                                                                                 |
| `ipv6`           | a /128 per imp, NAT66 and a routed /64, policies over IPv6, packet-too-big, a guest's router advertisement                                                                                          |
| `cpu`            | CPU limits: half a core holds a busy guest, again after a sleep and a wake, `imp set` at once, `imp top`, `docker exec` after the cgroup move                                                       |
| `templates`      | `imp template`: copies of a running imp's disk, a new machine-id and ssh host keys per copy, kept after a reboot, rm                                                                                |
| `boot-templates` | a cold boot restored from a boot template: its own name, MAC, disk size and TCP ISN secret; a sleep and wake after                                                                                  |
| `inner`          | the inner container: PID 1 inside, signals, `kill -9 -1`, a memory hog, a reboot and the listeners after it, `rm -rf /`, a wiped root                                                               |
| `moves`          | `imp move` to a second instance on a Docker network: cold with a checkpoint, an abort, warm moves of an open and a box imp that keep tmpfs and processes and reach DNS, HTTP and the broker at once |
| `moves-tailnet`  | `imp move` between two tailnet nodes: the real peer check, and a per-imp tailnet name that goes with its imp                                                                                        |
| `chaos`          | kills of impd, Firecracker and the container mid-operation; the watchdog; a full disk                                                                                                               |
| `ksm`            | with KSM on the host (CI's runner only): two jailed guests merge the same pages, their Pss falls, the budget holds after they diverge; skips elsewhere                                              |
| `backups`        | backups of running and stopped imps and checkpoints, restores, forget and prune, a stale lock, a corrupted pack                                                                                     |

```sh
scripts/test-e2e.sh                          # the acceptance set: every suite
scripts/test-e2e.sh --only fast              # the CI subset: lifecycle, checkpoints, disks, sleep, restart, mcp, offsets, services, ssh, ssh-agent, reverse, proxy, dashboard, tokens, leases, cpu, templates, boot-templates, inner, jail, ksm
scripts/test-e2e.sh --only checkpoints,sleep # named suites, run in the order above
scripts/test-e2e.sh --clean                  # wipe the dev instance's data first
```

| Flag      | Effect                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--only`  | Comma-separated suites or sets. `acceptance` (the default) is every suite; `fast` is the CI subset.                                     |
| `--clean` | Logs the instance out of the tailnet, removes the container and wipes its data dir, and the moves suites' second host and its data dir. |
| `--reuse` | Keeps a running dev instance instead of restarting it with the run's settings.                                                          |
| `--keep`  | Leaves the run's imps and fixture images in place for a look afterwards.                                                                |

The `acceptance` set is the definition of done: the tailscale suite fails without a Tailscale key
(from the env, 1Password or `.env`, as [configuration](./configuration.md#dev-instance) lists), and
the timing limits fail the run. Any other set skips tailscale without a key and only warns about a
missed limit. The harness starts Pebble for the https suite, which needs no domain and reboots the
instance with HTTPS on, then off again ([HTTPS](./https.md#testing-with-pebble)). The `fast` set
takes about 4.5 minutes, most of it idle timeouts in the sleep suite and the jail suite's two
reboots. The full set adds docker, images, scale and tailscale; at its defaults the scale suite
alone took about 75 seconds in the last acceptance run.

The moves suites start a second instance, `<IMP_DEV_NAME>-mv-b`, with its data in
`<IMP_DEV_DATA>-mv-b`, and reboot the run's instance onto a network of their own and back. Each
instance gets a 2 GiB RAM budget there, so a run stays inside one ordinary run's memory.
`moves-tailnet` needs a Tailscale key, as the tailscale suite does.

The per-imp names case of the tailscale suite skips unless `IMP_E2E_TAILNET_NAMES=1`: it needs the
Tailscale Services OAuth client in 1Password (`IMP_TAILNET_OAUTH_REF`, default
`op://cloud/imp-tailscale-oauth`, fields `client-id` and `client-secret`) and the tailnet policy in
[per-imp names](./tailscale.md#per-imp-names).

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
| `E2E_CHAOS_ROUNDS`      | 8       | fault rounds of the chaos suite                          |
| `E2E_CHAOS_SEED`        | random  | seed of the chaos suite; the log shows it                |

The scale suite needs the budget plus 2 GiB of free host memory, and free disk on the data volume
for a memory snapshot of each imp (count × memory). It restarts the instance with a 600 s idle
timeout, so the RAM governor, not idleness, decides which imps sleep; the suites after it keep that
timeout. On a smaller machine, lower the budget and the count, for example
`E2E_RAM_BUDGET_MIB=2560 E2E_SCALE_COUNT=10`. The count must pass the number of imps that fit, or
the governor sleeps none and the suite fails at once: an imp restored from a warm boot template owns
about 280 MiB at the default sizes, a cold-booted one about 320 MiB. The suite holds what the
Firecrackers own (`Pss_Anon` + `Pss_Shmem`, read from `smaps_rollup` without impd) to the budget,
and reports their full PSS, which also has clean file pages the governor does not count
([what the governor measures](../architecture/sleep-and-wake.md#5-ram-what-the-governor-measures)).

The connectors suite runs a fake github.com on this machine, which the dev container reaches on its
default gateway. A dev instance reads `<IMP_DEV_DATA>/broker-test-upstreams.json` when it exists
(`IMP_BROKER_TEST_UPSTREAMS`):

```json
{ "ca": "-----BEGIN CERTIFICATE-----…", "upstreams": { "github.com": "https://172.17.0.1:9443" } }
```

The broker then sends granted requests for those hosts to the fake, and trusts `ca` next to the
usual roots: verification stays on. The suite writes the file and removes it when it ends.

A run writes `.cache/e2e/results.json`: each suite's verdict and time, and the timings the suites
measure. A suite file also runs on its own against a running instance:
`bun test ./test/e2e/suites/sleep.e2e.ts`.

### Wake bench

`scripts/bench-wake.sh` is a manual check, not part of the harness or CI. It times wakes of an imp
put to sleep right after a cold boot, which a host kernel before Linux 6.7 makes slow
([young guests](../architecture/sleep-and-wake.md#young-guests)). It drives impd through the CLI
only, so it runs against any host, and it fails when the median wake passes `--limit-ms` (default
500):

```sh
scripts/bench-wake.sh --cycles 3       # IMP_URL and IMP_TOKEN, or the saved login
```

On the WSL2 dev box (host kernel 6.6.87), the median wake was 793 ms with impd's wait off
(`IMP_SLEEP_MIN_GUEST_UPTIME_MS=0`) and 142 ms with the default. On a host kernel with the fix, both
should be fast; record the host's `uname -r` with the result.

## Daemon tests

The daemon's tests need no VM. `packages/daemon/src/imps/test-imps.ts` runs the governed imp service
over an in-memory database and a fake VMM (`fake-vmm.ts`). A test scripts what the next boot, wake,
sleep, stop or agent check does (succeed, fail, die or hang), holds a step until it releases it, and
restarts impd over the same database and VMs. `findBrokenInvariants` reads the raw records, because
a read through the service repairs what it finds.

The property tests (`*.property.test.ts`) use fast-check. On a failure it prints the seed and the
path of the shrunk case. Pass both to `fc.assert` as `{ seed, path, endOnFailure: true }` to replay
the case.

## Dashboard tests

The [dashboard guide](./dashboard.md#tests) covers its component tests and its Playwright run.

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

| Job          | Required | What it runs                                                                                                                                                      |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitleaks`   | yes      | A secret scan over the history.                                                                                                                                   |
| `checks`     | yes      | `bun run audit`, the Bun pin check, `deadcode`, `format:check`, `lint`, `lint:docs`, `typecheck`, `bun test`, `test:pebble`, and the dashboard's tests and build. |
| `go`         | yes      | `gofmt`, `go vet ./...` and `go test -race ./...` in `agent/`.                                                                                                    |
| `shellcheck` | yes      | `bun run lint:shell`.                                                                                                                                             |
| `cli`        | yes      | Compiles the CLI for every platform and runs the linux-x64 one; builds the release image's compile stage.                                                         |
| `client`     | yes      | Packs `@zgeoff/imp-client`, installs it on the oldest Node it supports, and smokes it under Node, Bun and a compiled Bun binary.                                  |
| `e2e`        | yes      | The `fast` end-to-end set on real microVMs (below).                                                                                                               |
| `zfs`        | no       | `scripts/test-zfs.sh`, then real imps on a ZFS pool: `scripts/zfs-host-test.sh` with the lifecycle, checkpoints, disks, sleep and backups suites.                 |

The `checks` job also runs `bun run lint:docs`, which fails when a code comment cites a docs page or
heading that does not exist.

`bun run audit` ignores one advisory by its ID. GHSA-86w9-cpqp-85rv is a flaw in node-forge's RSA
signature verification, and no fixed node-forge exists (all versions up to 1.4.0). acme-client loads
node-forge, but impd uses only `acme.crypto`, which runs on Node's own crypto and never calls
node-forge to verify a signature. Drop the ignore when a fixed node-forge or an acme-client without
it ships.

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
   `main` write these caches; pull requests only read them. Steps 1 and 2 are the composite action
   `.github/actions/e2e-build`, which the `zfs` job uses too.
3. restores the Playwright browser cache (`~/.cache/ms-playwright`), keyed on the Playwright version
   in `bun.lock`, which pins the Chromium build. The dashboard suite installs that Chromium's
   headless shell when the cache misses.
4. runs `scripts/test-e2e.sh --only fast` with `E2E_RAM_BUDGET_MIB=4096`,
   `IMP_DEFAULT_MEMORY_MIB=1024` and the XFS file on the runner's `/mnt` disk. There is no Tailscale
   key in CI, and a missed timing limit only warns.

The `zfs` job builds the same inputs, reading the caches only, caps the ZFS ARC at 1 GiB, and runs
the lifecycle, checkpoints, disks, sleep and backups suites on a pool in a sparse file. The job
summary shows the ZFS timings, and the `zfs-e2e-results` artifact holds the logs.

After a pass, a failure or a timeout, the job saves the `e2e-results` artifact (14 days):
`results.json`, `metrics.jsonl`, `impd.log` (the dev container's whole log) and the dashboard
suite's Playwright traces and screenshots. A failed suite also prints the last 40 lines of impd's
log inline. Download the artifact with `gh run download <run-id> -n e2e-results`.

The job is a required check, and `release-please` waits for it. It became one after it passed on
every push to `main` from its first run (#2).

If GitHub-hosted runners lose KVM, move the job to an ephemeral, dedicated self-hosted runner and
run it only on push to `main`, never on pull requests. Never use the deploy box. The repo is public,
so a pull request from a fork would get a privileged container with `/dev/kvm` on that runner.

A new push to a pull request cancels its older run. On `main`, a run that has started finishes, but
a run still waiting behind it is cancelled when a newer push comes, so only the newest push runs
next.

`.github/workflows/bootstrap.yml` runs `scripts/test-bootstrap.sh --stub --zfs` when a pull request
or a push to `main` changes `deploy/` or the test ([Bootstrap a server](./install.md#test-it)). It
is not a required check.

`deploy/imp-host.args.json` holds the imp-host container's `docker run` arguments. After an edit,
`bun run render:deploy` writes them into `deploy/imp-host.service` and `bootstrap.sh`'s copy, and
`bun test` fails until it has (`scripts/render-imp-host.test.ts`). The NixOS module reads the file
itself.

`.github/workflows/nix.yml` checks the format of the `.nix` files and runs `nix flake check` when
`flake.nix`, `flake.lock`, `deploy/` or `tailscale-up.sh` change: the NixOS module's eval check, and
a NixOS VM test that needs KVM ([NixOS](./nixos.md#test-it)). It is not a required check.

`.github/workflows/reproducible.yml` runs `host/check-reproducible.sh` (the guest kernel and the
system drive rebuild to the same bytes). It takes two cold kernel builds, so it runs by hand:
`gh workflow run reproducible.yml`.

## Branch rules

`.github/rulesets/main.json` protects `main`: the seven required CI jobs must pass, changes arrive
through a squash-merged pull request, and the branch cannot be deleted or force-pushed. Only a
repository admin can bypass it.

The ruleset is not applied yet. Apply it once:

```sh
gh api -X POST repos/zgeoff/imp/rulesets --input .github/rulesets/main.json
```
