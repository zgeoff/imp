# The end-to-end harness

## A run, step by step

`e2e/test-e2e.sh` runs `e2e/main.ts`. The harness:

1. Brings the dev instance down and up with `scripts/dev/dev.sh` (`--reuse` keeps a running one),
   then checks the container's privileges against `deploy/` with `e2e/lib/privileges.ts`.
2. Reads the API token with `scripts/dev/dev.sh token` and sets `IMP_TOKEN` and `IMP_HOST_IMAGE`.
3. Resets the baseline for every suite's prefix (below), then builds the fixture images the selected
   suites list and impd does not have yet. This startup reset removes only what a suite prefix
   names, so an `e2e-` imp that matches no suite prefix survives it (the end-of-run cleanup in step
   6 still takes every `e2e-` imp and image). A removal impd refuses, such as `CONFLICT` for an
   image another imp boots, fails setup, and no suite runs.
4. Runs each suite's journey files, in the order of `SUITES` in `e2e/lib/suites.ts`. A suite's
   `journeys` list names its files under `e2e/suites/` in run order (`proxy` has four); a suite
   without one runs `<name>.e2e.ts` (`listJourneys`). Each journey file runs as its own process
   group (`e2e/lib/run-suite.ts`),
   `bun test --config=e2e/bunfig.toml --bail --timeout 3600000 ./e2e/suites/<journey>.e2e.ts`
   (`buildJourneyArgv`). `suites.test.ts` checks that every `*.e2e.ts` file belongs to exactly one
   suite. The first SIGINT or SIGTERM stops the running journey's group and runs no more journeys; a
   second exits at once. The harness forgets the journey's group as soon as it exits, before any
   reset, and `stopSuiteGroup` treats a group that is already gone (`ESRCH`) as stopped, so a signal
   during a reset does not crash the run.
5. After each journey file, whether it passed, failed or was stopped, resets the baseline for its
   suite's prefix (`e2e-<abbr>-`), unless `--keep`; with the startup reset, every journey starts on
   the baseline. After a journey that failed, and before that reset, it reboots the instance with
   the run's settings (`scripts/dev/dev.sh reboot`), since the journey may have left impd rebooted
   onto its own; an interrupted run skips that reboot, runs no more journeys, and fails the suite
   whose journeys it skipped. A passing `scale` keeps its imps when `restart` runs after it, the
   harness names scale's prefix to `restart` (`E2E_KEPT_PREFIXES`), which checks that the whole
   fleet is there, and `restart`'s first reset takes them; a failed `scale`, or one with no
   `restart` after it, gets the reboot and reset like any other suite. A journey whose process
   cannot start, or whose checks throw, fails like one that exits non-zero, and the run goes on. A
   reset or reboot that fails fails the suite, and the harness then makes the instance anew (the
   `--clean` reset below, then up with the run's settings, privilege check, token and fixture
   images) before the next journey; if that fails too, the run stops with the reason and fails. On
   the ZFS backend that reset also empties the run's root dataset (below). It also fails a suite
   when the impd log since one of its journeys started shows a boot-template fallback (the `chaos`
   suite may cause one). A suite passes only when every journey passed, and its time runs from its
   start to its last reset. The loop is `runSuites` in `e2e/lib/run-suites.ts`, which takes each
   step as a dependency; `run-suites.test.ts` checks the order of runs, reboots, resets and
   re-creations, between the journeys of one suite too.

   A suite's `settings` in `suites.ts`, a function of the instance that returns impd environment,
   puts every one of its journeys on those settings. The harness reads them as the suite starts and
   reboots onto them (`scripts/dev/dev.sh reboot` with that environment) before the first journey
   and again after any fresh instance; the reboot after a failed journey goes onto them too. After
   the last journey, a failure or an interrupt it reboots back onto the run's settings, under
   `--keep` too. A passing `scale` with `restart` after it is the exception: the instance stays on
   scale's settings, so `restart` re-adopts the fleet still running under scale's 600 s idle timeout
   (a reboot would sleep every VM), and the reboot back comes after `restart`'s last journey, or at
   once when an interrupt stops the run before `restart`. A read that throws fails the suite with no
   reboot and no journey; a reboot onto the settings that fails runs no more of its journeys, fails
   the suite and still reboots back; a reboot back that fails fails the suite and makes the instance
   anew, unless the run was interrupted, and the run stops if that fails. A suite without `settings`
   never reboots a passing run, so a `--reuse` instance keeps its own settings until a suite with
   `settings` or a failure reboots it onto the run's.

   A suite's `fixtures` name what runs beside the instance for all its journeys: `host-b`, the moves
   suites' second instance on a Docker network, or `host-b-tailnet`, the same on the tailnet under
   its own name (`buildHostBFixture` in `e2e/lib/move-hosts.ts`, with the options of
   `readMoveOptions`). The harness starts a fixture before the suite's first journey and before the
   reboot onto its settings, since the instance joins the fixture's network; after each journey,
   once the instance's reset is done, it resets the fixture (`resetBaseline` on B with the suite's
   prefix, which ends any move a journey left first); and after the reboot back it stops it. A
   fixture that will not start fails the suite with no journey; one whose reset fails goes down and
   up anew and fails the suite, and since B's stop takes A off its network, the next journey first
   reboots onto the suite's settings again; one that cannot come back runs no more of the suite's
   journeys; one that will not stop fails the suite. An interrupt skips the fixture's reset and
   still stops it, and `--keep` skips the reset only. A `receiving` imp on B whose source is gone
   fails B's reset, because `moves.abort` does not end it and impd will not remove it (`MOVING`).
   B's data dir stays between starts, so the fixture's start resets B once more, and when that reset
   fails too it takes B down, empties its data dir (the `--clean` wipe below) and starts it from
   nothing. Under `--keep` the start fails instead, so B keeps what the journeys left.

6. Unless `--keep`, or the instance could not be made anew, removes every `e2e-` imp and image, then
   writes `.cache/e2e/results.json`, merging the metrics suites append to `.cache/e2e/metrics.jsonl`
   (`E2E_METRICS_FILE`). The run passes only when every section passed, nothing stopped it, and no
   SIGINT or SIGTERM came, even one during the last reset or the cleanup (`checkRunPassed`); an
   interrupted run exits 130.

The wipe of `--clean`, of a re-creation and of a host B made from nothing deletes the data dir as
root, so the harness wipes only a dir under `<repo>/.data/` or one that holds an `imp.xfs`
(`resolveWipeTarget` in `e2e/lib/wipe-target.ts`). On the ZFS backend (`IMP_STORAGE_BACKEND=zfs`, as
`scripts/zfs-host-test.sh` runs it) it first asks `readZfsOwner` in `e2e/lib/zfs-owner.ts`, wherever
the dir sits, so a proven pool's root is emptied along with the data; a dir it cannot prove falls
back to the two rules above. The proof: the owner file `imp-e2e-zfs-owner` that `zfs-host-test.sh`
writes into it parses, its root is `IMP_ZFS_ROOT` and sits in its pool, its vdev sits beside the
data dir, and `zpool status -P` lists that vdev in that pool. Then the wipe keeps the owner file,
and `resetZfsRoot` destroys the root dataset with all its descendants (`zfs destroy -R`) and makes
it again. `zpool` and `zfs` run in a privileged container of the host image. `zfs-owner.test.ts`
checks each proof and the reset against a stand-in command runner; no test runs them on a real pool.

The baseline reset, `resetBaseline` in `e2e/lib/reset-baseline.ts`, takes impd's client
(`createInstanceClient` in `imp-cli.ts`, the run's root token) and a list of prefixes. It first ends
the move of each such imp that a failed move left marked (`moves.abort`), since impd refuses to
remove a marked imp with `MOVING`; an abort that cannot reach the move's target rejects the reset.
It then removes every imp named with one, and with it the imp's checkpoints, leases and the grants
it holds; then the networks, secrets, OAuth clients, tokens, and images and templates named with
one; then `<IMP_DEV_DATA>/broker-test-upstreams.json`. A fixture image (`e2e-<fixture>-<hash>`)
carries no suite prefix and stays. A removal impd refuses, such as an image another imp boots,
rejects the reset. `reset-baseline.test.ts` boots impd's real app (`createImpd` on the stub VMM) in
process, makes each of those kinds, resets, and reads every list back before and after; it also
checks that an unprefixed name, a near-miss prefix (`e2e-xy-` against `e2e-x-`) and an unprefixed
OAuth client stay, and that it removes an imp a failed boot left in `error`. Sessions and services
are not proven: making either needs a guest agent, which the stub VMM has no stand-in for. What the
reset does not cover: the instance's own settings (the reboot after a failure restores those), the
`moves` suites' second host (its fixture resets it, step 5, and `removeMoveLeftovers` takes it down
at the end of a run that includes them), and a registry container or SSH key a suite file made.

A journey file releases what it makes itself, in the order the scenario needs: its `setupTest()`
creates one `AsyncDisposableStack`, registers `onTestFinished(() => stack.disposeAsync())`, and
returns it with the run's client (`createInstanceClient`) and the suite's prefix (`readSuitePrefix`
in `suites.ts`). The test registers each removal on the line after the act that made the thing, with
`registerRemoval(stack, config.keep, remove)` (`register-removal.ts`):
`removeImpIfPresent(client, name)` after `impz new`, before the exec wait, and
`removeImageIfPresent(client, name)` after `impz template create`, and `removeTokenIfPresent`,
`removeSecretIfPresent` and `removeNetworkIfPresent` after `impz token new`, `impz secret add` and
`impz net create` (all in `reset-baseline.ts`), so an imp goes before the template it boots and the
network it joins. Each passes over a name the journey already removed and throws on any other
refusal; `reset-baseline.test.ts` checks each against the in-process impd. `scale` registers no
removal for its fleet, which the harness keeps for `restart` (step 5): the one exception to a
journey's own removals, kept because GEO-135's decision 1 retains "the ordered full-acceptance
scale/restart dependency". Under `--keep` (`E2E_KEEP=1`) `registerRemoval` defers nothing, so the
journey's imps and images stay, as the harness's resets and end-of-run cleanup also skip; other
releases, such as a proxy process or a held socket, still run.

A burst of connections past a guest server's accept backlog (busybox `httpd` on `e2e-tiny`) leaves
some that the agent's dial completed but the server never accepted; the guest kernel logs
`Possible SYN flooding` and drops them about 17 s later, which `impz proxy` reports as
`the connection in the imp was lost`. `proxy-tunnel-limit.e2e.ts` holds its connections on an
`nc -lk -e cat` echo server and proves each with a byte there and back before it opens the next.
Every suite file works this way; `proxy-refusals`, `socket-refusals` and `socket-builds` make no
imps and release their own processes and containers with `onTestFinished`. `registry`, `scale`,
`tailscale` and the two moves suites take their impd settings from the suite's `settings`, and the
moves journeys read their host B from the harness's fixture with `readMoveHosts` (step 5); each
makes and removes its own imps on both hosts. A journey that reboots the instance onto settings only
it needs, as `tailscale-names` does, passes them over its suite's own (`readSuiteSettings` in
`suites.ts`) to `runDevScript('reboot', …)`, and defers a reboot back onto the suite's settings, so
the journeys after it still run on them.

Each `socket-builds` test starts its own host-mode imp-docker-proxy container,
`<IMP_DEV_NAME>-docker-proxy-host-mode-<id>` on `/run/imp-docker/host-mode-<id>.sock`
(`buildHostModeProxyArgv` in `e2e/lib/host-mode-proxy.ts`), and removes both when it ends. A unix
socket path holds 107 bytes, which a worktree's `.cache/e2e/ssh-*` dir can pass, so `ssh-agent`
keeps its ssh control and forward sockets, and `ssh` its forward sockets, in a `mkdtemp` dir under
`TMPDIR`, and `startLocalSshAgent` (`e2e/lib/ssh.ts`) makes its agent's socket in one of its own
there, which its `stop()` removes. A journey that checks something keeps an imp awake past the idle
timeout waits with `waitAwakePastIdle` (`e2e/lib/awake-past-idle.ts`): the idle loop moves an imp's
`lastActiveAt` to its tick only while something keeps the imp awake, so a running imp whose
`lastActiveAt` reaches the idle timeout past the release has stayed awake that long; its wake count
and `sleptAt` must stay as the wait first read them once the imp ran, so a sleep and a wake in
between fail it. The wait polls `impz ls`, which records no activity, so the journey must not exec
in the imp during it.

A journey file also runs alone against an instance that is up:
`bun test --config=e2e/bunfig.toml ./e2e/suites/sleep-memory.e2e.ts`. Nothing then resets the
baseline or builds missing fixture images for it. `runDevScript` passes the run's
`IMP_RAM_BUDGET_MIB` and `IMP_IDLE_TIMEOUT_S` (from `config.ts`) under whatever `process.env` sets:
a suite that reboots the instance onto its own tuning sets them in `process.env`, and that must win.
So a shell's `IMP_RAM_BUDGET_MIB` or `IMP_IDLE_TIMEOUT_S` wins when a suite file runs alone; through
`main.ts` the two match the config.

Flags: `--only <suites or sets>`, `--group <1|2|3>`, `--clean`, `--reuse`, `--keep`; `--help` lists
the suites. The sets live in `SUITE_SETS`: `acceptance` (the default) is every suite, and `fast` is
the CI subset, built from `FAST_GROUPS` in `SUITES` order. `main.ts` sets `E2E_ACCEPTANCE=1` when
the run includes `acceptance`; tailnet suites then fail instead of skipping, and the timing limits
fail the run instead of warning. `scale` is not in `fast`; the acceptance run keeps it before
`restart` on the same instance.

`--group N` runs `FAST_GROUPS[N - 1]` from `suites.ts`: three static lists that make up `fast`, each
in `SUITES` order, for three runners with an instance each. `suites.test.ts` checks that no suite
sits in two groups and pins the `fast` set they make. They came to about 225 s of suite work each in
two CI runs:

| Group | Suites                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | lifecycle, registry, checkpoints, disks, restart, offsets, session-logs, services, ssh, ssh-agent, proxy, dashboard, tokens, leases, cpu, templates, boot-templates, socket |
| 2     | sleep, reverse, jail                                                                                                                                                        |
| 3     | mcp, inner, memory, ksm                                                                                                                                                     |

`HOST_TESTS_GROUP` (2) names the group whose runner also runs `bun run test:host`, so those tests
run once.

Fixture images come from `images/base` (`base`, a slow Docker build) and `e2e/fixtures/`
(`e2e-tiny`, `e2e-bare`, `e2e-ws`, `e2e-git`, `e2e-ra`). A fixture's name carries a hash of its
sources, so a changed fixture builds anew.

| Variable                             | Default     | Effect                                                 |
| ------------------------------------ | ----------- | ------------------------------------------------------ |
| `E2E_RAM_BUDGET_MIB`                 | 6144        | impd's RAM budget, passed through `scripts/dev/dev.sh` |
| `E2E_IDLE_TIMEOUT_S`                 | 10          | impd's idle timeout                                    |
| `E2E_SCALE_COUNT`                    | 30          | imps the scale suite creates                           |
| `E2E_SCALE_MEMORY_MIB`               | 512         | memory of each scale imp                               |
| `E2E_SCALE_FILL_MIB`                 | 256         | tmpfs each scale imp fills                             |
| `E2E_MAX_NEW_MS`                     | 3000        | limit for `impz new` plus the first exec               |
| `E2E_MAX_CHECKPOINT_MS`              | 500         | limit for a checkpoint of a running imp                |
| `E2E_CHAOS_ROUNDS`, `E2E_CHAOS_SEED` | 8, random   | the chaos suite's rounds and replay seed               |
| `IMP_DEV_NAME`                       | `imp-dev`   | the dev container                                      |
| `IMP_DEV_PORT_OFFSET`                | 0           | shifts every published port; needs `IMP_DEV_NAME`      |
| `IMP_DEV_DATA`                       | `.data/dev` | the instance's data dir, mounted at `/data`            |
| `IMP_DEV_READY_TIMEOUT_S`            | 600, 60     | `dev.sh`'s wait for /health on up, on restart          |
| `IMP_DEV_STOP_TIMEOUT_S`             | 30          | `dev.sh restart`'s wait for the old impd to exit       |

`scripts/dev/dev.test.ts` sets each of the two `dev.sh` deadlines to 1 s, against an impd that never
gets ready or never exits, beside a run where it does.

`main.ts` sets `E2E_KEEP`, `E2E_KEPT_PREFIXES`, `E2E_ACCEPTANCE`, and `E2E_METRICS_FILE` for each
suite process. It no longer sets `E2E_SUITES`: `scale` read it to keep its imps for `restart`, and
that choice is now the harness's (step 5). Suites that reboot the instance pass impd settings
through `process.env`, which `scripts/dev/dev.sh` forwards from its allowlist.

Suites with extra needs:

| Suite                        | Needs, or skips without                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `tailscale`, `moves-tailnet` | The `tag:imp-e2e` OAuth client and this machine `Running` on the tailnet; skips outside `acceptance` |
| `tailscale` per-imp names    | `IMP_E2E_TAILNET_NAMES=1` and the OAuth client in 1Password                                          |
| `registry`                   | `imp-e2e-registry.test` resolving to 127.0.0.1 and passwordless sudo; fails when `CI` is set         |
| `ksm`                        | `/sys/kernel/mm/ksm/run` set to 1 and a kernel of 6.10 or later                                      |
| `https`                      | Pebble, which `main.ts` starts only when the run includes `https`                                    |
| `moves`, `moves-tailnet`     | A second instance, `<IMP_DEV_NAME>-mv-b` with data in `<IMP_DEV_DATA>-mv-b`                          |
| `dashboard`                  | Playwright's Chromium; runs `packages/dashboard`'s `bun run e2e` against the instance                |
| `lifecycle` and others       | Public internet from the guest (`example.com`) and for fixture image pulls                           |

The tailnet suites join as `tag:imp-e2e`, never `tag:imp`: the tailnet policy lets `tag:imp-e2e`
reach only other `tag:imp-e2e` nodes on tcp 7070, so a test node cannot reach a live impd. When the
run includes `tailscale` or `moves-tailnet`, `main.ts` reads the `tag:imp-e2e` OAuth client secret
(`load_tailscale_e2e_authkey` in `scripts/lib.sh`): `IMP_E2E_TAILSCALE_AUTHKEY`, else
`op read op://imp-e2e/imp-e2e-tailscale-oauth/client-secret`. The `imp` op-mint profile's token
covers the `imp-e2e` vault and nothing else. `main.ts` drops any `TAILSCALE_AUTHKEY` from its env,
and without the e2e client it sets `IMP_DEV_TAILNET=0`, so a `tag:imp` key in `.env` never joins an
e2e node. A dev instance with `IMP_TAILSCALE_OP=1` reads the same client and joins as `tag:imp-e2e`
(`docs/runbooks/e2e-tailnet.md`). An instance that joined as `tag:imp` before keeps its node state:
run with `--clean` once.

The `e2e/lib/*.test.ts` unit tests run in plain `bun test` and need no KVM, Docker or dev instance.
Some start real processes: `reset-baseline.test.ts` boots impd's app in process (`createImpd` on the
stub VMM), and `run-suite.test.ts` spawns Bun processes and their children. A test or stand-in that
runs git, or a tool that runs it (`git receive-pack`, `git http-backend`), spawns it through
`runGitCommand`, `runGitChecked` or `createGitFreeEnv` in `e2e/lib/git-env.ts`: a git hook exports
`GIT_DIR` and the other variables `git rev-parse --local-env-vars` lists into `bun test`, and a git
child that inherits them works on this checkout whatever its `-C` says.

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
5. Optional: `packages/cli/src/image/run-image-build.test.ts` runs the real `docker buildx` and
   skips when it is missing.

- `IMP_HOST_TESTS=required` makes the `canUnshare` probe (`packages/daemon/src/test-utils/`) of each
  host test true, so a missing tool or namespace fails the test instead of skipping it.
  `build-unshare.ts` there adds a user namespace (`-r`) only when the uid is not 0.
  `deploy/bootstrap.test.ts`'s `nft -c` check of the rendered firewall reads it too; plain
  `bun test` skips that check where `unshare -rn nft` fails.
- A test that needs a disk feature that tmpfs lacks, such as the XFS backend's FIEMAP test, makes
  its directory under `/var/tmp`, the disk-backed temp root, because `tmpdir()` is a tmpfs on some
  hosts. It never uses the checkout. Where `/var/tmp` is a tmpfs too, the test fails rather than
  passing on the wrong filesystem.
- `scripts/ci/check-kvm.sh` checks for `vmx` or `svm` and that `/dev/kvm` opens for read and write.
  The dev container gets `/dev/kvm` and `/dev/net/tun` from `deploy/imp-host.args.json`, plus
  `/dev/loop-control` and loop devices for its XFS file.
- The end-to-end harness drives the container that `scripts/dev/dev.sh` starts: `IMP_DEV_NAME`
  (default `imp-dev`), with data in `IMP_DEV_DATA` (default `.data/dev`, a sparse `imp.xfs`) and the
  API on `localhost:7070` plus `IMP_DEV_PORT_OFFSET`. `e2e/lib/instance.ts` takes the API URL from
  `IMP_URL` when it is set, and throws when `IMP_DEV_PORT_OFFSET` is set without `IMP_DEV_NAME`. The
  token comes from `scripts/dev/dev.sh token`, so it is the dev instance's.
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
  `e2e/lib/create-registry-trust.ts`. It makes that directory with `sudo mkdir` and no `--parents`,
  so a directory already there is refused untouched; a failed owner-file write or certificate copy
  removes the directory again; and its release removes only that directory, once, never
  `/etc/docker/certs.d` itself. `create-registry-trust.test.ts` runs it in a temp root with no sudo
  (`certsRoot`, `asRoot`). Each test takes the trust itself and releases it with `onTestFinished`
  right after, since `--bail` skips `afterAll` once any test fails. Taking it writes an owner file,
  `imp-e2e-owner` (the process's pid and its start time from `/proc/<pid>/stat`), into the
  directory; when this process's start time cannot be read it makes nothing, since no later run
  could prove the directory. A process killed mid-test still leaves the directory, so each
  acquisition first runs `removeStaleRegistryTrusts` for the registry's host: it removes a
  `<host>:*` directory only when its owner file parses and its pid's start time is not the recorded
  one (the process is gone, or its pid now names another). A directory with no owner file, one that
  does not parse, one that records no start time, and one whose owner still runs all stay, and
  `mkdir` then refuses the last three if they hold the same port. Each `registry-*` journey starts
  its own registry and trusts its own certificate (`e2e/lib/registry-steps.ts`). `startRegistry`
  refuses a container name already taken before it makes anything, labels the container
  `imp-e2e-instance=<IMP_DEV_NAME>`, and defers its removal into the journey's stack once
  `docker run` succeeds; `createMovedTag` defers each tag's removal as soon as the tag exists. Each
  journey first runs `removeStaleRegistries`, which removes only the containers named
  `e2e-reg-registry-*` that carry this instance's label, and logs and leaves the rest.
  `registry-steps.test.ts` runs these against a stub `docker` on `PATH`.
