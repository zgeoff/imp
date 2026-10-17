---
name: project-testing
description:
  imp's test commands, test layers and harness traps — which run covers which files, what each run
  needs, and the impz-specific traps in the preloads, stand-ins, impd boot and the end-to-end
  harness. Load beside the testing skill whenever you design, write, run, or review tests in this
  repo.
---

# imp tests

The `testing` skill holds the rules. This skill holds only what is particular to imp: the traps that
cost time here, the commands, and the layers they cover. The references hold the detail for one area
each; open one when the task touches its area.

## References

- [preloads-and-utils.md](./references/preloads-and-utils.md): the root and dashboard preloads, the
  two kinds of util for cleanup order, and what a daemon `setupTest()` returns.
- [stand-ins.md](./references/stand-ins.md): the kinds of stand-in and when to use each, booting
  impd and its harnesses, Bun's timer and transport facts, and the broker's test upstreams.
- [e2e.md](./references/e2e.md): what a run does around each journey, what the baseline reset
  covers, how to write a journey, sets and groups, and host safety.
- [zfs-nixos-go-ci.md](./references/zfs-nixos-go-ci.md): when to use the ZFS fake or a real pool,
  the NixOS checks, agent Go timer and golden tests, and the CI facts that a test change touches.

## Traps

- **Cleanup runs first-in, first-out.** On Bun 1.4.2, `onTestFinished` callbacks run in registration
  order, and a callback that throws skips the ones after it. A util that registers its own cleanup
  therefore releases before anything the test registers after it.
- **Ambient `IMP_*` settings vanish.** The root preload deletes every `IMP_*` variable the shell
  passed, except the run gates in [Layers](#layers), so a developer's settings never reach a unit
  test. Set an impd setting with [`updateEnv`](../../../packages/test-utils/src/update-env.ts)
  before `setupTest()`, which reads it through
  [`readImpEnv`](../../../packages/test-utils/src/read-imp-env.ts).
- **MSW sees only `fetch`, and not all of it.** A `fetch` to loopback or a unix socket skips MSW and
  goes to the real network. `node:http` clients and WebSockets bypass MSW too, so those boundaries
  need a real stand-in server.
- **Reuse a stand-in before writing one.** imp has a tested stand-in for nearly every boundary;
  [stand-ins.md](./references/stand-ins.md) sorts them by kind and links each package's folder. To
  boot a real impd, use [`createImpd`](../../../packages/daemon/src/create-impd.ts) on the stubs, or
  [`createImpTest`](../../../packages/daemon/src/imps/test-imps.ts) for the governed-imps harness.
- **`createImpd` disks are 32 GiB.** A test whose storage clones with `copyFile` sets
  `defaultDiskBytes` to 0, or each checkpoint copy or fork takes minutes.
- **`createImpd`'s `now` does not reach every clock.** Some services stay on the wall clock;
  [Booting impd](./references/stand-ins.md#booting-impd) lists the gaps and the clocks those
  components take instead.
- **Ports come from [`findFreePorts`](../../../packages/daemon/src/test-utils/find-free-ports.ts).**
  It claims each port until the test ends, so parallel test processes never share one. A fixed port
  collides.
- **tmpfs lacks disk features.** `tmpdir()` is a tmpfs on some hosts; a test that needs FIEMAP or
  similar makes its directory under `/var/tmp`, never in the checkout.
- **Git hooks leak `GIT_DIR`.** A test that runs git spawns it through the helpers in
  [`git-env.ts`](../../../e2e/lib/git-env.ts), `runGitCommand`, `runGitChecked` or
  `createGitFreeEnv`; otherwise a child git works on this checkout whatever its `-C` says.
- **One impd runs one suite at a time.** A worktree's dev instance needs its own `IMP_DEV_NAME` and
  `IMP_DEV_PORT_OFFSET`. A journey run alone gets no baseline reset and no fixture image build.
- **A journey removes what it makes.** It registers each removal with
  [`registerRemoval`](../../../e2e/lib/register-removal.ts) on the line after the act that made the
  thing, so an imp goes before the template it boots.

## Commands

| Layer                       | Command                                                                                                         | Needs                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Unit and package (one file) | `bun test <path>`                                                                                               | Bun, bash, git, jq, tar, truncate, mkfs.ext4                   |
| Unit and package (all)      | `bun test`                                                                                                      | The same, and more memory than a small host has                |
| Dashboard components        | `bun run test:dashboard`                                                                                        | Bun                                                            |
| Agent Go                    | `scripts/test-go.sh`                                                                                            | Go from `agent/go.mod`                                         |
| Agent Go, root-only tests   | `cd agent && sudo -E env "PATH=$PATH" go test -tags root -race ./...`                                           | Root, a writable cgroup2                                       |
| Host networking             | `sudo env "PATH=$PATH" IMP_HOST_TESTS=required bun run test:host`                                               | Root, `nft`, `iptables`, `ip6tables`, `ip`, `ping`, `sysctl`   |
| ACME issuer                 | `bun run test:pebble`                                                                                           | Docker                                                         |
| Build disk hold             | `IMP_TEST_SMALL_FS=<dir> bun test packages/daemon/src/images/create-image-builds.test.ts -t 'small filesystem'` | A 4 GiB loop-mounted filesystem at `<dir>`; a tiny tmpfs fails |
| End to end                  | `e2e/test-e2e.sh [--only <suites> \| --group <1-3>] [--clean \| --reuse] [--keep]`                              | KVM, Docker; `--help` lists suites and extra needs             |
| One journey                 | `bun test --config=e2e/bunfig.toml ./e2e/suites/<journey>.e2e.ts`                                               | A dev instance that is already up                              |
| NixOS module evaluation     | `nix build -L --no-link .#checks.x86_64-linux.eval`                                                             | Nix with flakes                                                |
| NixOS VMs                   | `nix build -L --no-link .#checks.x86_64-linux.vm`                                                               | Nix with `kvm nixos-test` system features                      |
| ZFS on a real pool          | `sudo env "PATH=$PATH" scripts/test-zfs.sh`                                                                     | Root, the zfs module, `zpool`                                  |
| ZFS host with VMs           | `scripts/zfs-host-test.sh`                                                                                      | sudo, Docker, KVM, the zfs module                              |

CI runs every row but the lone journey, in [`ci.yml`](../../../.github/workflows/ci.yml) and
[`nix.yml`](../../../.github/workflows/nix.yml). When this host lacks what a row needs, push and
read that CI job's result instead of working around it.

## Layers

- Plain `bun test` loads every `*.test.ts` except `packages/dashboard/**`, which only
  `bun run test:dashboard` runs.
- `*.e2e.ts` and `*.pebble.ts` never run in plain `bun test`; each runs only when its `./` path is
  given, which the e2e harness and `test:pebble` do.
- Gated tests load in plain `bun test` and skip: the real-pool ZFS tests until `IMP_TEST_ZFS_ROOT`
  and `IMP_TEST_ZFS_DIR` are set, the small-filesystem tests until `IMP_TEST_SMALL_FS` is, and each
  host networking test where its namespace probe fails. `IMP_HOST_TESTS=required` turns that skip
  into a failure.
- Go tests that need root carry the `root` build tag.
- `e2e/lib/*.test.ts` are unit tests of the harness: they run in plain `bun test` with no KVM.
