# Install

imp runs on one Linux machine, in one host container, in one of two ways:

- **The release image** for a server: impd, the `imp` CLI, the guest kernel and the system drive are
  baked in, and nothing from the repo is mounted. [Bootstrap a server](#bootstrap-a-server) sets up
  a fresh server with one command; [run the release image](#run-the-release-image) covers the steps
  by hand.
- **The dev instance** for working on imp: `scripts/dev.sh` builds the host container and runs impd
  from the repo. The [set up](#set-up) steps below cover it.

## Needs

- `/dev/kvm`: bare metal, or a VM with nested virtualization (WSL2 works).
- Docker. The host container is privileged and mounts the Docker socket.
- A host kernel with the iptables `rpfilter` and `addrtype` matches (`xt_rpfilter`, `xt_addrtype`).
  The host container loads its rules into its own network namespace, and the guard against spoofed
  guest addresses and the broker's port rule need both. Most distribution kernels and WSL2 have
  them; `setup-net.sh` fails at start without them.
- [Bun](https://bun.sh) for the CLI, and Go for the guest agent.
- Disk for the sparse XFS file. `IMP_STORAGE_GIB` (default 200) sets its apparent size; it uses only
  what imps write.

## Set up

1. Clone the repo and install the dependencies:

   ```sh
   git clone https://github.com/zgeoff/imp && cd imp
   bun install
   ```

2. Build the guest kernel. The first build takes about 9 minutes; the
   [kernel README](../../kernel/README.md) has the details.

   ```sh
   kernel/build.sh
   ```

3. To put imps on your tailnet, write a tagged auth key to `.env` in the repo root. The
   [Tailscale guide](./tailscale.md) covers the key and the ACL.

   ```sh
   TAILSCALE_AUTHKEY=tskey-auth-…
   ```

4. Start impd. `up` builds the host image and the system drive when they are missing, starts the
   container, and waits until impd reports ready.

   ```sh
   scripts/dev.sh up
   ```

5. Give the CLI the token:

   ```sh
   scripts/dev.sh token | scripts/imp login http://localhost:7070 --name dev
   ```

   Or `export IMP_TOKEN=$(scripts/dev.sh token)` in each shell.

6. Check it:

   ```sh
   imp info
   imp new box && imp exec box -- uname -a
   ```

**NOTE:** The guides write `imp` for the CLI. From the repo, `scripts/imp` runs it; link it onto
your `PATH` as `imp`, or use `scripts/imp` in its place.

[Configuration](./configuration.md) lists every variable, and [operations](./operations.md) covers
restarts and day-to-day care.

## What `dev.sh up` does

- Builds the `dev` target of `host/Dockerfile` as the host image, and rebuilds
  `build/imp-system.squashfs` (the agent's system drive) from `agent/`, so a changed agent reaches
  the next imp. The Docker cache makes the rebuild take about half a second when the agent is
  unchanged. With `IMP_SYSTEM_DRIVE` set, it uses that drive as it is.
- Starts the container with `--privileged --device /dev/kvm`, the Docker socket, and the repo
  mounted at `/src` and at its own path.
- Keeps data in `.data/dev/imp.xfs`, a sparse XFS file that the container loop-mounts on
  `/var/lib/imp`.
- Publishes the API on 7070, the proxy on 7080, and per-imp ports 20000–20063.

## WSL2 notes

- The WSL 6.6 kernel rejects newer `mkfs.xfs` defaults. `setup-storage.sh` passes
  `-i nrext64=0,exchange=0 -n parent=0`.
- WSL's uplink MTU is 1360. `dev.sh` passes it to the container, which clamps guest TCP MSS to
  match.
- If the host runs Tailscale with MagicDNS, the container uses public resolvers instead, because its
  own tailscaled would capture `100.100.100.100`.

## Bootstrap a server

[`deploy/bootstrap.sh`](../../deploy/bootstrap.sh) takes a fresh Ubuntu 24.04 or 26.04, or Debian
13, server, x86_64 with KVM, to a running impd. It is one file with no other repo files, so copy it
to the server and run it as root:

```sh
curl -fsSLO https://raw.githubusercontent.com/zgeoff/imp/main/deploy/bootstrap.sh
install -m 0600 /dev/null /root/ts-key && vi /root/ts-key        # the auth key, one line
bash bootstrap.sh --dry-run --data-device /dev/nvme1n1 --tailscale-authkey-file /root/ts-key
bash bootstrap.sh --yes --data-device /dev/nvme1n1 --tailscale-authkey-file /root/ts-key
```

Run it in a root login, or with `sudo --preserve-env=SSH_CONNECTION`: plain `sudo` drops
`SSH_CONNECTION`, which the firewall phase reads to keep your session's port open, so the script
refuses it. `sudo -E` is not enough on Ubuntu 26.04, whose `sudo-rs` ignores `-E`. `--dry-run`
prints every change and makes none. `--check` does the same and exits 2 when a change is pending, 1
on an error or a refusal, and 0 when nothing is pending. A run changes only what differs from what
it wants, so a second run changes nothing.

**CAUTION:** `--data-device` formats the device. The script refuses a device that is mounted, has
partitions, is a RAID or LVM member, holds the root filesystem, or has any signature but XFS (or,
with ZFS, the pool's own). Check the device name with `lsblk` before the run all the same.

The phases run in order:

- **preflight:** Checks root, the OS, x86_64, `/dev/kvm` and `vmx`/`svm`, before any change.
- **packages:** Installs `xfsprogs`, `nftables`, `jq` and Docker CE from Docker's apt repo. A Docker
  that is already installed stays. With ZFS, also `zfsutils-linux`; on Debian, `zfs-dkms` and the
  kernel headers from `contrib`, which the script adds.
- **storage:** Makes `--data-device` XFS with reflink (fstab by UUID), or creates the `--loop-file`
  on the root filesystem (fstab `loop`). Mounts it on `/var/lib/imp`. With `/var/lib/imp` already
  mounted, it only checks it is XFS with reflink. With ZFS, see [ZFS](#zfs).
- **kernel:** Writes `vm.overcommit_memory = 1` and `vm.swappiness = 1` to
  `/etc/sysctl.d/90-imp.conf`, and `kvm`, `tun` and `loop` to `/etc/modules-load.d/imp.conf`, and
  applies both. Swap stays as the installer made it. With ZFS, also `zfs`, and the ARC cap in
  `/etc/modprobe.d/imp-zfs.conf`.
- **firewall:** Disables `ufw` and `firewalld`, and loads `/etc/imp/firewall.nft` with
  `imp-firewall.service`, after `nft -c` accepts the ruleset. It refuses while `nftables.service` is
  enabled.
- **imp:** Writes `/etc/imp/imp-host.env` (0600) and `/etc/systemd/system/imp-host.service`, pulls
  the image (or loads `--image-archive`), and starts the unit. The unit has
  `RequiresMountsFor=/var/lib/imp`, so it never starts before the XFS mount. With ZFS, a drop-in
  orders it after `zfs.target`.
- **tailscale:** With a key in the env file, waits for the node to be `Running`, then blanks the key
  ([the Tailscale key](#the-tailscale-key)).
- **health:** Waits for `imp info`, checks that `imp-host` publishes ports on `127.0.0.1` only, and
  that a joined tailnet node is `Running`. Then it creates, runs `uname -a` in, and destroys an imp
  from `ubuntu`. `--skip-health` skips it.

### Disk layout

Give imp a disk or a partition of its own. Put the OS on the rest:

| Mount          | Size                              | Notes                                                            |
| -------------- | --------------------------------- | ---------------------------------------------------------------- |
| `/`            | 50–100 GiB                        | The OS, Docker's images and the env file.                        |
| swap           | what the installer makes, ≤ 8 GiB | `vm.swappiness = 1` keeps guest memory in RAM.                   |
| `/var/lib/imp` | the rest                          | XFS with reflink: imp disks, snapshots, memory files and images. |

OVH Rise and Vultr bare metal ship two NVMe disks, and their installers can put the OS on a RAID 1
of both. Either keep the second disk out of the RAID and give it as `--data-device`, or make a RAID
array or partition for imp in the installer and give that (`--data-device /dev/md2`). The script
does not partition disks. OVH's default template gives the free space to `/home`; the script refuses
that partition while it is mounted, so pick a layout without it in the installer.

A host with no spare disk, such as a VPS with one virtual disk and no block volumes, takes
`--loop-file /srv/imp.xfs`: a sparse XFS file on the root filesystem, loop-mounted on
`/var/lib/imp`. By default it gets the free space on `/` less the larger of 30 GiB and 15 %, which
the OS, Docker's images and logs keep; `--loop-size GIB` sets the size instead. The file is refused
below 20 GiB. It puts a loop device in the I/O path, so prefer a disk or partition when there is
one. ZFS needs a device; the script makes no pool on a file.

### ZFS

`--storage zfs` puts imp on a ZFS pool instead ([storage](../architecture/storage.md#zfs)):

```sh
bash bootstrap.sh --yes --storage zfs --data-device /dev/nvme1n1   # pool tank, dataset tank/imp
bash bootstrap.sh --yes --storage zfs --zfs-pool fast              # an existing pool: fast/imp
```

- With `--data-device`, the script creates the pool on it (`ashift=12`, `compression=lz4`,
  `atime=off`, `xattr=sa`, `mountpoint=none`), or imports it when the device already holds that
  pool. Without it, the pool must be imported already; make a mirror that way.
- It creates `<pool>/imp` with `mountpoint=legacy` and sets `IMP_STORAGE_BACKEND=zfs` and
  `IMP_ZFS_ROOT=<pool>/imp` in the env file. The host never mounts the dataset; the container mounts
  it on `/var/lib/imp`, and impd creates the children.
- A later run without `--storage` keeps the env file's backend. The script refuses to switch
  backends, since the imps would stay behind on the old one.
- ZFS takes no `--loop-file`.
- The host image ships the 2.4 tools, which match Ubuntu 26.04's module. On Ubuntu 24.04 (module
  2.2) impd starts and warns about the minor skew ([versions](../architecture/storage.md#versions)).

### RAM budget

The script sets `IMP_RAM_BUDGET_MIB` to the RAM the kernel reports, less the larger of 8 GiB and 15
%. The host keeps that for itself, Docker, impd and the page cache. With ZFS, the script caps the
ARC at 10 % of RAM, within 1 to 8 GiB, and takes that out of the budget too: uncapped, the ARC grows
to half of RAM. On a 64 GB box:

| What                                    | XFS MiB | ZFS MiB |
| --------------------------------------- | ------- | ------- |
| MemTotal (64 GB reports about 62.5 GiB) | 64,000  | 64,000  |
| Kept for the host: max(8192, 15 %)      | 9,600   | 9,600   |
| ZFS ARC cap (`zfs_arc_max`)             | none    | 6,400   |
| `IMP_RAM_BUDGET_MIB`                    | 54,400  | 48,000  |

On XFS that is about 170 awake imps at the 317 MiB that `STATUS.md` measured for an imp filling 256
MiB, or 26 at 2 GiB each fully used. Sleeping imps cost disk, not RAM.

The script writes the budget when the env file holds the template's `16384` or nothing. Any other
value is yours and stays.

### The Tailscale key

The key goes to `/etc/imp/imp-host.env` only, and is never printed. The host container is the
tailnet node; the host OS stays off the tailnet, and you reach it over public SSH.

Use a tagged, non-ephemeral, single-use key ([Tailscale guide](./tailscale.md)). Once the node is
`Running`, the script blanks the key in the env file: the node state in `/var/lib/imp/tailscale`
keeps it joined, and `tailscale-up.sh` starts `tailscaled` from that state when there is no key. A
later run with `--tailscale-authkey-file` sees the saved state and does not write the key again. An
older image that still needs the key at every start keeps it, and the script warns. To join again
(after the node was removed from the tailnet, say), delete `/var/lib/imp/tailscale` and run the
script with a new key.

### Firewall

The `inet imp_host` table filters input only, for IPv4 and IPv6 alike: loopback, established
connections, ICMP and ICMPv6 (neighbour discovery and router adverts), the DHCP and DHCPv6 clients,
and SSH. Every other port is closed on both, and `imp-host` publishes its ports on `127.0.0.1` only;
the health phase fails when one is published on `0.0.0.0` or `::`. Docker keeps the forwarding
rules, and a reload replaces this table alone. The SSH ports are those `sshd -T`, `ssh.socket` and
the live `sshd` listeners report, plus `--ssh-port`. The script refuses the run when the current SSH
session's port is not among them, and warns when `sshd` allows password logins.

### Test it

`scripts/test-bootstrap.sh` runs the script in a privileged container with systemd as PID 1, on
Debian 13 and Ubuntu 24.04 and 26.04, with a loop file and Docker inside. It checks `--check` on the
fresh host, a first run, `--check` and a second run with no change. It fails when the host's `vm.*`
and `kernel.*` sysctls or loaded modules change. In a container, the script writes the kernel
settings and does not apply them. On Debian it also checks the `--data-device` refusals and what
`--check --storage zfs` plans. `--zfs` adds a real ZFS run on Ubuntu 24.04, on a pool with a unique
name that the test destroys; it needs the zfs module loaded on the host, which WSL2 does not have.

```sh
scripts/test-bootstrap.sh --stub --zfs                        # a stand-in image (what CI runs)
scripts/test-bootstrap.sh --image imp-host:<tag> --health     # a release image; boots an imp
```

Nothing has run on a real OVH or Vultr server yet.

## The CLI on another machine

The `imp` CLI is one binary with no runtime to install, for Linux and macOS on arm64 and x64. Each
release attaches it to the GitHub release.

**NOTE:** imp has no release yet. Until the first one, run the CLI from a checkout (`scripts/imp`,
which needs Bun). `install.sh` works from the first release. `brew install` works once the owner has
also set up the tap ([RELEASING.md](../../RELEASING.md#homebrew-tap)).

```sh
curl -fsSL https://raw.githubusercontent.com/zgeoff/imp/main/install.sh | sh  # into ~/.local/bin
brew install zgeoff/tap/imp                                                  # with completions
```

`install.sh` checks the binary against the release's `SHA256SUMS` before it installs it, and checks
its provenance attestation too when the `gh` CLI is on `PATH` and logged in. `IMP_INSTALL_VERSION`
pins a release and `IMP_INSTALL_DIR` picks the directory.

macOS quarantines a binary downloaded with a browser, and Gatekeeper then refuses to run it. Clear
the flag once (Homebrew and `install.sh` use curl, which sets no quarantine flag):

```sh
xattr -d com.apple.quarantine ./imp-darwin-arm64
```

Then point it at an impd and its token (impd writes the token to `<IMP_DATA_DIR>/token`):

```sh
imp login https://imp.example.ts.net
imp ls
```

[Configuration](./configuration.md#cli) covers saved hosts, `--host` and shell completions.

## Run the release image

The release image runs the compiled impd from `/usr/local/bin/impd` with the kernel and the system
drive from `/usr/local/share/imp`. `imp info` shows the kernel version and the sha256 of both.

### Get it

Each release pushes the image to `ghcr.io/zgeoff/imp-host`, tagged with its version and `latest`,
for linux/amd64 only. The GitHub release has the CLI for Linux and macOS (`imp-linux-x64`,
`imp-linux-arm64`, `imp-darwin-x64`, `imp-darwin-arm64`), the guest kernel `vmlinux` and the system
drive `imp-system.squashfs`, both x86_64 and the same bytes as in the image, and `SHA256SUMS` over
all of them. [RELEASING.md](../../RELEASING.md) shows how to check the checksums and the provenance
attestations.

```sh
docker pull ghcr.io/zgeoff/imp-host:latest
gh release download -R zgeoff/imp -p 'imp-linux-x64' -p SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS && install -m 0755 imp-linux-x64 ~/.local/bin/imp
```

Both deploy files run `latest`; set `IMP_HOST_IMAGE` to pin a version.

### Build it

```sh
host/build-release.sh          # tags imp-host:<git describe>; IMP_VERSION overrides the version
```

The build is multi-stage: the guest kernel, the agent and its system drive, impd and the CLI each
build in their own stage. The kernel stage reads only `kernel/version`, `kernel/config-base`,
`kernel/docker.fragment` and `kernel/make-vmlinux.sh`, so a change anywhere else reuses the cached
kernel layer. A CI runner without that cache rebuilds the kernel; pass `--cache-from` and
`--cache-to` through `build-release.sh` to keep it.

The kernel toolchain and `mksquashfs` come from dated Ubuntu and Debian snapshots, and the build
stamps and drive times are fixed, so the same sources give the same `vmlinux` and
`imp-system.squashfs` bytes. `kernel/build.sh` and `scripts/build-system-drive.sh` use the same
stages, so the dev instance boots the same bytes as the release image. A release that leaves them
alone does not change which drive or kernel the imps boot, and impd keeps an older drive while a
snapshot needs it ([upgrades](./operations.md#upgrade)). Only these two files are reproducible; the
image digest is not (apt packages, timestamps and the compiled impd differ per build).

`host/check-reproducible.sh` checks it: one cold build, one on a fresh builder, and one after a
change under `packages/`. It takes 5 to 20 minutes; the `Reproducible` workflow runs it in CI by
hand.

### Prepare the host

1. Put `/var/lib/imp` on an XFS filesystem with reflink, a partition of its own:

   ```sh
   mkfs.xfs -m reflink=1 /dev/<partition>
   echo '/dev/<partition> /var/lib/imp xfs defaults 0 2' >> /etc/fstab
   mkdir -p /var/lib/imp && mount /var/lib/imp
   ```

   The release image refuses to start when `/var/lib/imp` is not an XFS mount with reflink. It never
   falls back to a loop file inside the container, which would go away with the container and take
   every imp with it.

2. Write the settings, from [`deploy/imp-host.env.example`](../../deploy/imp-host.env.example):

   ```sh
   install -d /etc/imp
   install -m 0600 deploy/imp-host.env.example /etc/imp/imp-host.env   # then edit it
   ```

   Without `TAILSCALE_AUTHKEY` the host is local-only: the API and the proxy listen on
   `127.0.0.1:7070` and `127.0.0.1:7080`, and no imp is reachable from another machine. With a key,
   the tailnet reaches impd and every imp through the container's own `tailscaled`. Use a
   non-ephemeral tagged key on a server ([Tailscale guide](./tailscale.md)).

### Start it

Use one of the two, not both. Both run the container with `--init --privileged --device /dev/kvm`,
the host's Docker socket and `/var/lib/imp`, and give impd 120 seconds to sleep every imp on stop.

- **systemd:** [`deploy/imp-host.service`](../../deploy/imp-host.service) runs `docker run` in the
  foreground, so systemd supervises it.

  ```sh
  install -m 0644 deploy/imp-host.service /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now imp-host
  ```

- **Compose:** [`deploy/compose.yaml`](../../deploy/compose.yaml), with a Docker restart policy.
  Needs Docker Compose 2.24 or later, for the `env_file` entry with `path` and `required`.

  ```sh
  docker compose -f deploy/compose.yaml up -d
  ```

  On shutdown, `dockerd` stops the container and systemd waits 90 seconds for `docker.service` by
  default. Give it the 120 seconds impd needs with a drop-in:

  ```ini
  # /etc/systemd/system/docker.service.d/imp-stop.conf
  [Service]
  TimeoutStopSec=150
  ```

The systemd unit needs no drop-in: it stops the container itself before Docker stops.

Then, on the host:

```sh
docker exec imp-host imp info     # the CLI is in the image and finds the token itself
```

### Images on a server

`imp image build <dir>` builds from a directory impd can see, and in the release image the repo is
not there: the build fails with `does not exist on the impd host`. Build the image with the host's
Docker, then add it:

```sh
docker build -t imp-base images/base
imp image add imp-base --name base
```

Until an image named `IMP_DEFAULT_IMAGE` (default `base`) exists, `imp new` uses `ubuntu` and impd
logs a warning at start.
