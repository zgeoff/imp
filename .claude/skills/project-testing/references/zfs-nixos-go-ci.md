# ZFS, NixOS, agent Go and CI

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
- **The real-pool tests.** The real-pool tests of `zfs-backend.test.ts`, which follow its tests on
  the fake, and `create-zfs-moves.test.ts` skip unless `readZfsTestPool()`
  (`test-utils/read-zfs-test-pool.ts`) finds `IMP_TEST_ZFS_ROOT` (a dataset) and `IMP_TEST_ZFS_DIR`
  (its mount dir) both set. Each test makes its own dataset with `createZfsTestDataset`: a new
  `mkdtemp` dir under the mount dir names it, a dataset of that name that `zfs list` already shows
  is refused untouched, and the caller's stack releases only what was made (`umount -R` of the dir,
  `zfs destroy -R`, then the empty dir). Its tests run it against `buildStubZfs`.
  `test-utils/write-synced-file.ts` fsyncs a disk file before a snapshot.
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
  `mount`, `umount` and `bun` on `PATH` (`scripts/test-utils/create-stub-bin.ts`), a `zfs` that
  prints its version and can fail a create (`create-stub-zfs.ts`), and a `zpool` that keeps its
  pools in a state file (`create-stub-zpool.ts`), in a temp root: the refusals for a user other than
  root, a missing module and a missing `zpool`, a normal release, a work dir made with its parents,
  the collisions (a symlinked `pool.img` included), a failed `zfs create`, a failed `zpool create`,
  a failed destroy, a pool that still uses the file, a failed `zpool` query, a work dir path with
  spaces, and SIGTERM during the create and mid-run. For the create, the `zpool` stub writes a
  marker and holds until the test writes a release file (or fails after 30 s), so the test sends
  SIGTERM after the marker and before the release, inside the create.
- **`scripts/zfs-host-test.sh`** runs `test-zfs.sh` (unless `IMP_ZFS_TEST_UNIT=0`), then starts a
  dev instance `imp-zfs` (port offset `IMP_DEV_PORT_OFFSET`, default 300) with
  `IMP_STORAGE_BACKEND=zfs` on a second sparse pool `impbench<pid>` of `IMP_ZFS_BENCH_GIB`
  (default 40) in `<dir>/bench.img`, runs the suites in `IMP_ZFS_E2E_SUITES` (default
  `checkpoints,sleep`), and writes `<dir>/summary.txt`; `<dir>` keeps the results and is made,
  parents included, when it does not exist. Before it touches anything it refuses a bench pool name
  that `zpool list` already shows, a `bench.img` (a symlink included), `data` or `data-mv-b` already
  in the work dir, an `imp-zfs` or `imp-zfs-mv-b` container, and an `imp-zfs-mv` network that is
  already there; so a second run in the same dir is refused. It claims `<dir>/data` and
  `<dir>/data-mv-b`, the moves suites' B, with `mkdir`. It makes B's root dataset
  `<IMP_ZFS_ROOT>-mv-b` beside the instance's, which `readHostBZfsRoot` in `e2e/lib/move-hosts.ts`
  gives B, and once the pool and both datasets exist it writes an owner file `imp-e2e-zfs-owner`
  with each root into each data dir, which lets `main.ts` make either instance anew (see
  [e2e.md](./e2e.md)). The e2e run goes in the background, its output through `tee` into
  `<dir>/e2e.log`, so TERM (143) or INT (130) reaches the trap at once and cleanup stops it first.
  Its EXIT cleanup releases only what the run made: once the run started the instance, it takes a B
  the run left up down with `dev.sh down`, its docker proxy and volumes included, collects the impd
  log, stops the instance and removes the move network, destroys the pool only when
  `zpool status -P` lists this run's `bench.img` (the whole path), and removes that file only when
  no pool lists it and `zpool` could say so. A pool that will not go keeps its file and fails the
  run. One exception: when `zpool` says the pool is busy and `dmesg --since` the pool's create shows
  a kernel oops with a ZFS frame in that oops's own trace, the run prints the oops, keeps the pool
  and its file, and exits with the suites' status. Such an oops kills its task inside ZFS, as the
  kernel's usercopy check does to a Firecracker `read()` of an imp's disk on Ubuntu's 6.17 kernel
  with OpenZFS 2.3.4, and the hold that task had on the disk's dataset lasts until a reboot, so no
  unmount or retry frees the pool. `IMP_ZFS_MODULE_VERSION_FILE` is read as in `test-zfs.sh`.
  `scripts/zfs-host-test.test.ts` runs a copy of the script beside the real `lib.sh` and stand-in
  `dev.sh`, `test-e2e.sh` and `test-zfs.sh` (`create-stub-repo-script.ts`), with stub `sudo`, the
  `zfs` stub, a `docker` that knows only the containers a test lists, some of them once a marker
  file exists (`create-stub-instance-docker.ts`), a `dmesg` that prints the log a test gives it, and
  the stateful `zpool` on `PATH`: the refusal for a missing module, a normal release with its owner
  files, a work dir made with its parents, the pool, file, symlink, data dir, container and network
  collisions, a failed `zpool create`, a failed destroy with no oops, a busy pool with a ZFS oops or
  a page-fault oops in ZFS, a busy pool with an oops outside ZFS beside a ZFS warning or after a ZFS
  soft lockup, a destroy that fails another way after a ZFS oops, a pool that still uses the file, a
  failed `zpool` query, a work dir path with spaces, and SIGTERM during the held create and during
  an e2e run that has B up.

## NixOS

The flake's two checks test `deploy/nixos/module.nix`:

- **`checks.x86_64-linux.eval`** comes from `deploy/nixos/tests/eval.nix`, which returns `cases`
  (the flake's `tests` output) and `check`. The cases are nix-unit cases, each named `"test …"`,
  since nix-unit runs only attributes whose names start with `test` and recurses into every other
  attribute set; each holds the observed value as `expr` and the literal as `expected`. A refusal
  case expects the module's exact failed assertion messages. The hosts that several cases read sit
  in the file's `let`, because each host is a full `nixosSystem` evaluation and building it again in
  every case would slow the check. Each case that reads a shared host has a comment above it that
  names the host and the option its expected value depends on, so the option that decides the case
  stays beside it. A host that one case reads is written in that case. `check` runs
  `nix-unit --flake ${self}#tests` inside its build, against a store of its own in the build
  directory, with `--override-input nixpkgs` pointing at the pinned nixpkgs in the store, as
  nix-unit's flake-parts module does; nix-unit is the pinned nixpkgs' `pkgs.nix-unit` (2.34.2, built
  on that nixpkgs' Nix 2.34). Then it builds the generated files (the env writer, the staging
  scripts, the proxy's run script, bootstrap.sh's ruleset) and greps them under `set -x`; a negative
  check passes only on grep's exit 1, not on an unreadable file.
- **`checks.x86_64-linux.vm`** is `deploy/nixos/tests/vm.nix`, one `runNixOSTest` with two nodes,
  `host` and `own`, and named subtests in the Python driver. The script runs own's scenario first,
  on its fresh node; then the host's first start; then the checks of that started host, where each
  scenario that changes the host (the forward rule, the listeners, the proxy stop, IPv6 off and on)
  restores it and checks the restore; then the rest of the Tailscale join journey, whose steps
  depend on each other. Every firewall there drops without a reject, so a dropped connection is the
  `timeout 5` exit: 124 on a node (GNU coreutils), and 143 inside the stand-in image, whose busybox
  `timeout` execs the command and kills it with SIGTERM. The driver's `fail` is kept for a refusal
  whose cause the subtest checks another way, such as the journal. The stub image's `tailscale` is
  `scripts/test-utils/run-stub-vm-tailscale.sh`, which `run-stub-vm-tailscale.test.ts` tests.

`.github/workflows/nix.yml` checks the format with `nix fmt -- --check` and builds each check in its
own job; the `vm` job opens `/dev/kvm` to the builders. The local `nixfmt` must be the pinned
nixpkgs' version (1.5.0) for its output to match.

## Agent Go timers

Five agent timers sit on unexported fields that each constructor sets from the package's constant. A
test in the same package shortens or lengthens one before it starts the work, and nothing outside
the package changes it:

| Package             | Field          | Default constant | What it bounds                                            |
| ------------------- | -------------- | ---------------- | --------------------------------------------------------- |
| `internal/exec`     | `drainGrace`   | `drainGrace`     | output forwarded after the process exits                  |
| `internal/exec`     | `hangupGrace`  | `hangupGrace`    | the wait for a process after the host hangs up            |
| `internal/session`  | `killGrace`    | `killGrace`      | the gap between a killed session's SIGHUP and its SIGKILL |
| `internal/inner`    | `firstBackoff` | `minBackoff`     | the first wait before the container restarts              |
| `internal/services` | `firstBackoff` | `minBackoff`     | the first wait before a service restarts                  |

A test in each package checks the constructor's default. The session manager's `recorded` hook is
nil outside tests. It gets each retired run once the manager has kept or passed over it, so a test
waits on it for a run that ended after its replacement.

## Agent Go golden and boundary tests

In the session history's replay suite, beside the golden and determinism tests,
`TestHistoryReplayMatchesTheGolden` feeds a large seeded output past the real history limit and pins
the replay by its length and SHA-256, because that replay is too large to write inline. The seed and
the generator live in the test file, so the input changes only by an edit there, and a changed
replay means editing the pinned constants on purpose.

The server's freeze tests swap `waitAndGrow` for a recorder of the sizes `grow` asks for. The real
`disk.WaitAndGrow` resizes the guest's own disk through sysfs and an ioctl, and `disk_test.go`
covers that kernel edge through stand-ins inside the disk package. A recorder at an own package's
boundary fits when that package's kernel edge has its own tests and the test asserts only whether
and how the call was made.

## CI

`.github/workflows/ci.yml`:

- **`checks`** runs `bun test`; the build disk hold on a 4 GiB loop-mounted XFS that it formats,
  mounts with sudo, and names in `IMP_TEST_SMALL_FS`; `bun run test:pebble`; and
  `bun run test:dashboard`.
- **`e2e-group`** runs the end-to-end work as a matrix of three groups, one KVM runner each, with
  `fail-fast: false` so every group reports. Each runs `scripts/ci/check-kvm.sh` first, hands the
  cpu cgroup controller to containers, turns KSM on, picks `/mnt/imp-e2e` or `.data/ci` as
  `IMP_DEV_DATA`, builds inputs with `.github/actions/e2e-build`, adds `imp-e2e-registry.test` to
  `/etc/hosts`, and runs `e2e/test-e2e.sh --group <n>` with `E2E_RAM_BUDGET_MIB=4096` and no
  Tailscale key. Only group 2 runs the host networking tests as root with `IMP_HOST_TESTS=required`,
  only group 1 sets up Playwright's browser (`if: matrix.browser`), and only group 1 on a push to
  `main` writes the build caches (`WRITE_CACHE`, which `.github/actions/e2e-build` takes as
  `write-cache`). `Cache Bun Packages` is a plain `actions/cache` step in all three groups, so any
  group may save the Bun package cache when its key misses. Each uploads `.cache/e2e/` and
  `packages/dashboard/.test-results/` as `e2e-results-<n>`. `e2e/lib/ci-groups.test.ts` pins these
  against the workflow file.
- **`e2e`** (a required check) is the aggregate: it needs `e2e-group` and passes only when
  `needs.e2e-group.result` is `success`.
- **`zfs`** (not required) runs `scripts/ci/check-kvm.sh`, installs ZFS, runs `scripts/test-zfs.sh`
  with `IMP_ZFS_TEST_DIR` blank, then `scripts/zfs-host-test.sh` with `IMP_ZFS_TEST_UNIT=0` and
  `IMP_ZFS_E2E_SUITES=lifecycle,checkpoints,disks,sleep,backups,boot-templates,moves`.
- **`go`** runs `gofmt -l`, `go vet ./...` and `scripts/test-go.sh` in `agent/`, with
  `GO_TEST_JSONFILE` under `runner.temp`, and uploads that JSON as `go-test-results`, whether the
  tests pass or fail. Last, it runs the `root`-tagged suite again as root.
