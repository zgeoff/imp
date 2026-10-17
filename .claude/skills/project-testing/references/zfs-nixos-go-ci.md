# ZFS, NixOS, agent Go and CI

These four areas each have a test layer outside the plain `bun test` run. This file says which layer
to use for a change and what each one proves; the scripts and their tests show how each layer runs.

## ZFS

Test the ZFS backend against the in-memory `zfs` fake,
[`buildStubZfs`](../../../../packages/daemon/src/test-utils/build-stub-zfs.ts), first. The fake
models datasets, snapshots, clones, promote, deferred destroy and legacy mounts, and it can block,
fail or crash a command and restart, so a test can stop a backend halfway through an operation. Its
space numbers are fixed, and it refuses to unmount a dir that is not itself a mount, as util-linux
does.

Write a real-pool test only for behaviour that depends on the kernel module, such as space
accounting or a real mount. Real-pool tests skip until their two gates name a dataset and its mount
dir. Each one makes its own dataset under the mount dir, refuses a dataset that already exists, and
releases only what it made.

Two scripts run the real-pool layer:

- **The real-pool script**, [`test-zfs.sh`](../../../../scripts/test-zfs.sh), makes a throwaway
  sparse-file pool, runs the ZFS backend's tests with both gates set, and destroys the pool on exit
  when `zpool status` proves the pool is its own.
- **The ZFS host script**, [`zfs-host-test.sh`](../../../../scripts/zfs-host-test.sh), runs the
  real-pool script, then runs end-to-end suites on a ZFS-backed dev instance over a second throwaway
  pool. `IMP_ZFS_E2E_SUITES` picks the suites.

Both scripts have tests that run them against stub binaries; a change to either script's cleanup
extends those tests.

## NixOS

The flake has two checks of the NixOS module:

- **The evaluation check** runs nix-unit cases and then builds the generated files and greps them.
  nix-unit runs only the attributes whose names start with `test`, so each case is named `"test …"`.
  Hosts that several cases read sit in the file's `let`, because each host is a full NixOS
  evaluation, and a comment above each such case states the host and the option its expected value
  depends on. A negative grep passes only on grep's exit status 1, so an unreadable file fails the
  check.
- **The VM check** is one NixOS test with two nodes. Each scenario that changes the host restores it
  and checks the restore, so the scenarios after it start from the started host. Every firewall
  there drops without a reject, so a dropped connection shows as the `timeout` command's exit: 124
  on a node, and 143 inside the stand-in image, whose busybox `timeout` kills with SIGTERM.

The format check runs `nix fmt -- --check`, and a local `nixfmt` matches it only at the pinned
nixpkgs' version.

## Agent Go

An agent timer that a test must shorten sits on an unexported field, which the constructor sets from
the package's constant. A test in the same package changes the field before it starts the work,
nothing outside the package changes it, and one test per package checks the constructor's default.

The session history's replay is too large to pin inline, so its golden test pins the replay's length
and SHA-256 over a seeded input that the test file generates. The input changes only by an edit to
that file, and a changed replay means editing the pinned values on purpose.

A recorder in place of an own package's function fits when that package's kernel edge has its own
tests and the test asserts only whether and how the call was made. The server's freeze tests record
disk grow calls this way, because the disk package tests the sysfs and ioctl edge itself.

## CI

Every command in the skill's table runs in a CI job, in
[`ci.yml`](../../../../.github/workflows/ci.yml) or
[`nix.yml`](../../../../.github/workflows/nix.yml). Two facts about those jobs matter when you
change a test:

- The end-to-end work runs as three groups on KVM runners, and the required `e2e` check passes only
  when every group passes. One group also runs the host networking tests as root, and one sets up
  the dashboard's browser. A unit test pins these roles against the workflow file, so a change to
  the groups changes both.
- The `zfs` job is not a required check. It installs ZFS on its runner and runs both ZFS scripts, so
  a ZFS failure on a pull request shows there and nowhere else.
