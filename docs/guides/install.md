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
- Docker. The host container runs as root with the capabilities in
  [privileges](../architecture/host-contract.md#privileges). It reaches Docker through
  `imp-docker-proxy`, a second container, never the host's socket
  ([the Docker socket](../architecture/host-contract.md#the-docker-socket)). That closes the Docker
  socket path only: `SYS_ADMIN` still lets root out of the container.
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

- Builds the `dev` target of `host/Dockerfile` as the host image, tagged for this checkout
  ([worktrees](./development.md#worktrees)), and rebuilds `build/imp-system.squashfs` (the agent's
  system drive) from `agent/`, so a changed agent reaches the next imp. The Docker cache makes the
  rebuild take about half a second when the agent is unchanged. With `IMP_SYSTEM_DRIVE` set, it uses
  that drive as it is.
- Starts `<name>-docker-proxy` first: this checkout's proxy, compiled with `bun build --compile` as
  the release image compiles it, with the proxy's privileges from `deploy/imp-host.args.json`. Its
  socket directory and token are Docker volumes of their own, which `dev.sh down` removes.
- Starts the container with the deploy's privileges (`deploy/imp-host.args.json`, with this
  checkout's seccomp profile), the loop devices, the proxy's socket, and the repo mounted at `/src`
  and at its own path.
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
to the server and run it as root. Take it from a release tag: it runs the image of its own release
([run the release image](#get-it)).

<!-- x-release-please-start-version -->

```sh
curl -fsSLO https://raw.githubusercontent.com/zgeoff/imp/v0.31.0/deploy/bootstrap.sh
install -m 0600 /dev/null /root/ts-key && vi /root/ts-key        # the auth key, one line
bash bootstrap.sh --dry-run --data-device /dev/nvme1n1 --tailscale-authkey-file /root/ts-key
bash bootstrap.sh --yes --data-device /dev/nvme1n1 --tailscale-authkey-file /root/ts-key
```

<!-- x-release-please-end -->

Log in as root to run it. The firewall phase reads `SSH_CONNECTION` to keep your session's port
open, and plain `sudo` drops it, so the script refuses a run under `sudo` without it. If you must
use `sudo`, check first that `sudo --preserve-env=SSH_CONNECTION env | grep SSH_CONNECTION` prints
the variable, then run the script that way. `sudo -E` is not enough on Ubuntu 26.04, whose `sudo-rs`
ignores `-E`. `--dry-run` prints every change and makes none. `--check` does the same and exits 2
when a change is pending, 1 on an error or a refusal, and 0 when nothing is pending. A run changes
only what differs from what it wants, so a second run changes nothing.

**CAUTION:** `--data-device` formats the device. The script refuses a device that is mounted, has
partitions, is a RAID or LVM member, holds the root filesystem, or has any signature but XFS (or,
with ZFS, the pool's own). Check the device name with `lsblk` before the run all the same.

The phases run in order:

- **preflight:** Checks root, the OS, x86_64, `/dev/kvm` and `vmx`/`svm`, before any change. It
  refuses an env file whose last `IMP_HOST_IMAGE=` is empty, which would give the units no image,
  unless `--image` sets it.
- **packages:** Installs `xfsprogs`, `nftables`, `jq` and Docker CE from Docker's apt repo. A Docker
  that is already installed stays. With ZFS, also `zfsutils-linux`; on Debian, `zfs-dkms` and the
  kernel headers from `contrib`, which the script adds.
- **storage:** Makes `--data-device` XFS with reflink (fstab by UUID), or creates the `--loop-file`
  on the root filesystem (fstab `loop`). Mounts it on `/var/lib/imp` with `nosuid`. With
  `/var/lib/imp` already mounted, it only checks it is XFS with reflink, and warns when it lacks
  `nosuid`. An fstab entry an older bootstrap wrote, without `nosuid`, is kept with the same
  warning. With ZFS, see [ZFS](#zfs).
- **kernel:** Writes `vm.overcommit_memory = 1` and `vm.swappiness = 1` to
  `/etc/sysctl.d/90-imp.conf`, and `kvm`, `tun` and `loop` to `/etc/modules-load.d/imp.conf`, and
  applies both. Swap stays as the installer made it. With ZFS, also `zfs`, and the ARC cap in
  `/etc/modprobe.d/imp-zfs.conf`.
- **ksm:** Only with `--ksm` or `--no-ksm`. `--ksm` writes `/etc/tmpfiles.d/imp-ksm.conf`, which
  starts ksmd with zero-page merging at boot, applies it, and sets `IMP_KSM=1` in the env file. It
  refuses in a container and on a kernel older than 6.10. `--no-ksm` removes the rule, writes 2 to
  `/sys/kernel/mm/ksm/run`, which stops ksmd and unmerges every merged page, and sets `IMP_KSM=0`. A
  running imp keeps its merge flag until it restarts, and impd logs each such VM it adopts. Off by
  default: read the caution in
  [KSM](../architecture/sleep-and-wake.md#8-ksm-sharing-identical-guest-pages) first.
- **firewall:** Disables `ufw` and `firewalld`, and loads `/etc/imp/firewall.nft` with
  `imp-firewall.service`, after `nft -c` accepts the ruleset. It refuses while `nftables.service` is
  enabled. With `--host-firewall none`, it does none of this ([Firewall](#firewall)).
- **ipv6:** With IPv6 on, keeps the host's router adverts, then creates the `imp-host` Docker
  network ([IPv6](#ipv6)). With `--ipv6 off`, removes what an earlier run made.
- **imp:** Writes `/etc/imp/imp-host.env` (0600), `/etc/systemd/system/imp-host.service` and
  `imp-docker-proxy.service`, pulls the image of the script's release, or the `--image` it pins in
  the env file (or loads `--image-archive`), and refuses an image whose `imp.host-contract` label is
  not `socket-proxy`. It starts the proxy, then imp-host. The proxy is the only Docker socket
  imp-host sees, and closes that path only: `SYS_ADMIN` still lets root out of the container
  ([the Docker socket](../architecture/host-contract.md#the-docker-socket)). The unit has
  `RequiresMountsFor=/var/lib/imp`, so it never starts before the XFS mount. With ZFS, a drop-in
  orders it after `zfs.target`.
- **tailscale:** With a key in the env file, waits for the node to be `Running`, then blanks the key
  ([the Tailscale key](#the-tailscale-key)).
- **health:** Waits for `imp info`, checks that `imp-host` publishes ports on `127.0.0.1` only, and
  that a joined tailnet node is `Running`. With IPv6 on, it checks that the container has an IPv6
  default route and that impd logged IPv6 on. Then it creates, runs `uname -a` in, and destroys an
  imp from `ubuntu`, with 512 MiB. `--skip-health` skips it.

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
value is yours and stays. On a host too small for the formula, where the budget comes out below 512
MiB, the script refuses the run, prints the RAM and the formula, and asks you to set
`IMP_RAM_BUDGET_MIB` in `/etc/imp/imp-host.env` yourself.

### The Tailscale key

The key goes to `/etc/imp/imp-host.env` only, and is never printed. The host container is the
tailnet node; the host OS stays off the tailnet, and you reach it over public SSH.

Use a tagged, non-ephemeral, single-use key ([Tailscale guide](./tailscale.md)). Once the node is
`Running`, the script blanks the key in the env file: the node state in `/var/lib/imp/tailscale`
keeps it joined, and `tailscale-up.sh` starts `tailscaled` from that state when there is no key. A
later run with `--tailscale-authkey-file` sees the saved state and does not write the key again. An
older image that still needs the key at every start keeps it, and the script warns. After the blank,
the script restarts `imp-host`, so the key leaves the container's environment too.

Delete the `--tailscale-authkey-file` source after the run (the script reminds you); it is the only
copy left. To join again (after the node was removed from the tailnet, say), delete
`/var/lib/imp/tailscale` and run the script with a new key.

**CAUTION:** An image older than the key-less start (`imp.tailscale-keyless` label) skips
`tailscaled` when the key is blank. A rollback to such an image takes the node off the tailnet at
its next start. Put a new key in `/etc/imp/imp-host.env` before you roll back that far.

### Firewall

The `inet imp_host` table filters input only, for IPv4 and IPv6 alike: loopback, established
connections, ICMP and ICMPv6 (neighbour discovery and router adverts), the DHCP and DHCPv6 clients,
and SSH. Every other port is closed on both, and `imp-host` publishes its ports on `127.0.0.1` only;
the health phase fails when one is published on `0.0.0.0` or `::`. Docker keeps the forwarding
rules, and a reload replaces this table alone. The SSH ports are those `sshd -T`, `ssh.socket` and
the live `sshd` listeners report, plus `--ssh-port`. The script refuses the run when the current SSH
session's port is not among them, and warns when `sshd` allows password logins.

On a host whose platform owns the firewall, run with `--host-firewall none`. The script then adds no
host rules and leaves `ufw` and `firewalld` alone, and the env file records
`IMP_HOST_FIREWALL=none`, so later runs keep it. On a host that an earlier run gave the `imp_host`
table, the flag removes the table and `imp-firewall.service`. Without the flag, a table that is
still there beside `IMP_HOST_FIREWALL=none` is drift: `--check` exits 2, and `--yes` refuses. imp
needs no inbound port either way ([host contract](../architecture/host-contract.md#firewall)).

### IPv6

Imps get IPv6 only when the `imp-host` container has an IPv6 default route
([IPv6](../architecture/networking.md#ipv6)). Docker's default bridge is IPv4 only, so with IPv6 on,
`imp-host` runs on its own Docker network instead:

```sh
docker network create --ipv6 --subnet <IMP_HOST_SUBNET6> \
  -o com.docker.network.bridge.name=br-imphost imp-host
```

Docker's NAT66 gives the container an IPv6 default route, and impd's `IMP_SUBNET6=auto` puts the
imps behind its own NAT66 on top. The bridge has a fixed name, `br-imphost`, so a host firewall can
admit it; on NixOS the module does ([IPv6 on NixOS](./nixos.md#ipv6)).

- **`--ipv6 auto|on|off`:** `auto`, the first run's default, is on when the host's IPv6 default
  route leaves through an interface with a global address. The env file records `IMP_HOST_IPV6=on`
  or `off`, and later runs keep it, so a host whose route is down for a moment does not lose imps'
  IPv6. `IMP_HOST_SUBNET6` is a random unique local /64, made once; `IMP_HOST_NETWORK` is
  `--network imp-host`, the words the unit passes to `docker run`.
- **A host bootstrapped before IPv6:** its env file has no `IMP_HOST_IPV6`, so a re-run resolves
  `auto`. When that comes out on, the run creates the network and restarts `imp-host` on it. When
  the host's router adverts need a client's config first (below), `auto` warns and stays off.
- **Docker:** 27.0 or later, which writes the NAT66 and forward rules for the network itself. An
  older Docker, or `"ip6tables": false` in `/etc/docker/daemon.json`, refuses `on` and turns `auto`
  off with a warning.
- **A network that differs:** another subnet, no IPv6, or another bridge name. `--check` reports it,
  and a run stops `imp-host` and creates the network again, when nothing else is on it. The unit
  only creates the network when it is missing, so after a manual change run the script.
- **Off again:** `--ipv6 off` stops `imp-host`, removes the network and the router advert file
  below, and `imp-host` comes back on the default bridge. Every imp that has an IPv6 prefix boots
  cold at its next start ([a new prefix](../architecture/networking.md#a-new-prefix)). An env file
  that says off beside the network is drift: `--check` exits 2, and `--yes` refuses.

**CAUTION:** Docker turns on `net.ipv6.conf.all.forwarding` for an IPv6 network. With forwarding on,
the kernel ignores router adverts on an interface with `accept_ra=1`. A host whose IPv6 default
route comes from router adverts then loses the route when it expires, about half an hour later, and
the host's IPv6 with it. The ipv6 phase settles this before it creates the network:

- **The kernel takes the adverts** (`accept_ra` is 1): the script writes
  `/etc/sysctl.d/90-imp-ipv6.conf` with `net/ipv6/conf/<uplink>/accept_ra = 2`, which keeps them
  with forwarding on, and applies it. The slash form keeps a dotted name such as `eth0.100` whole.
  The file stays when you roll the host back or remove imp; `--ipv6 off` removes it, and the live
  value stays until a reboot.
- **A client takes them** (`accept_ra` is 0): systemd-networkd (and netplan, which uses it),
  NetworkManager or dhcpcd. networkd keeps them with forwarding on when the uplink's `.network` file
  says `IPv6AcceptRA=yes` (netplan: `accept-ra: true`), and the script reads that. For any other
  client, `--ipv6 on` stops, says which client it found, and asks you to check its config, and
  `auto` warns and stays off. Run again with `--ipv6 on --ra-handled` once the client keeps router
  adverts with forwarding on, and check `ip -6 route show default` half an hour later. A later run
  with the network in place only logs the client.
- **A static route,** or no IPv6 default route: nothing to do.

Docker also sets the `ip6tables` FORWARD policy to DROP when it turns forwarding on. Anything else
on the host that forwards IPv6, such as dual-stack k3s or a VPN, needs its own accept rules, or
`"ip-forward-no-drop": true` in `/etc/docker/daemon.json`
([packet filtering](https://docs.docker.com/engine/network/packet-filtering-firewalls/)).

**CAUTION:** With `--host-firewall none`, the platform's input filter alone decides what imp traffic
on `br-imphost` (or `docker0`) reaches on the host itself. Make sure it drops input from those
bridges to host services that imps must not reach, such as a k3s API or a database on a host
address.

A routed /64 instead of NAT66 is not automated: set `IMP_SUBNET6=<prefix>` and route the prefix to
the container's address on `imp-host` ([IPv6](../architecture/networking.md#ipv6)).

### Test it

`scripts/test-bootstrap.sh` runs the script in a privileged container with systemd as PID 1, on
Debian 13 and Ubuntu 24.04 and 26.04, with a loop file and Docker inside. It checks `--check` on the
fresh host, a first run, `--check` and a second run with no change. It fails when the host's `vm.*`
and `kernel.*` sysctls or loaded modules change. In a container, the script writes the kernel
settings and does not apply them; `accept_ra`, which is per network namespace, it applies. Each
distro runs with `--ipv6 on`, as CI has no IPv6 route out. On Debian it also checks a network with
another subnet, `accept_ra=2` on a dotted interface with a fake router-advert route, `--ipv6 off`,
the refusal when a client takes the adverts, the `--data-device` refusals and what
`--check --storage zfs` plans. With `--health`, an imp also reaches an IPv6 address outside the
container. `--zfs` adds a real ZFS run on Ubuntu 24.04, on a pool with a unique name that the test
destroys; it needs the zfs module loaded on the host, which WSL2 does not have.

```sh
scripts/test-bootstrap.sh --stub --zfs                        # a stand-in image (what CI runs)
scripts/test-bootstrap.sh --image imp-host:<tag> --health     # a release image; boots an imp
```

Nothing has run on a real OVH or Vultr server yet.

## The CLI on another machine

The `imp` CLI is one binary with no runtime to install, for Linux and macOS on arm64 and x64. Each
release attaches it to the GitHub release.

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

<!-- x-release-please-start-version -->

```sh
docker pull ghcr.io/zgeoff/imp-host:0.31.0
gh release download -R zgeoff/imp -p 'imp-linux-x64' -p SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS && install -m 0755 imp-linux-x64 ~/.local/bin/imp
```

<!-- x-release-please-end -->

The deploy files run the image of their own release: `deploy/bootstrap.sh`, both units and
`deploy/compose.yaml` name `ghcr.io/zgeoff/imp-host:X.Y.Z`, the version in imp's `package.json`, and
`deploy/upgrade.sh` moves the host to the release it comes from
([upgrade](./operations.md#upgrade)). On `main`, `package.json` holds the last release until the
next one, so the files there can name an image older than their own code. Files from a release tag
name that release's image, which is why [bootstrap a server](#bootstrap-a-server) fetches
`bootstrap.sh` from one. A release tag's image appears on ghcr.io when `release.yml` pushes it,
about 30 to 60 minutes after the tag.

To run another image, set `IMP_HOST_IMAGE`: in `/etc/imp/imp-host.env` for the systemd units, in the
shell or the `.env` next to the compose file for compose, or with `bootstrap.sh --image`. Each
release also moves the `latest` tag; pin it on purpose with
`IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host`.

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
   echo '/dev/<partition> /var/lib/imp xfs defaults,nosuid 0 2' >> /etc/fstab
   mkdir -p /var/lib/imp && mount /var/lib/imp
   ```

   The release image refuses to start when `/var/lib/imp` is not an XFS mount with reflink. It never
   falls back to a loop file inside the container, which would go away with the container and take
   every imp with it. For ZFS in place of XFS, set `IMP_STORAGE_BACKEND=zfs` and `IMP_ZFS_ROOT`
   ([ZFS](#zfs)).

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

Use one of the two, not both. Both run the container with the privileges of
[`deploy/imp-host.args.json`](../../deploy/imp-host.args.json)
([privileges](../architecture/host-contract.md#privileges)) in a private cgroup namespace (for
[CPU limits](./cpu-limits.md)), the socket of `imp-docker-proxy` and `/var/lib/imp`, and give impd
120 seconds to sleep every imp on stop. Both need the seccomp profile at
`/etc/imp/imp-host.seccomp.json`:

```sh
install -D -m 0644 deploy/imp-host.seccomp.json /etc/imp/imp-host.seccomp.json
```

- **systemd:** [`deploy/imp-host.service`](../../deploy/imp-host.service) runs `docker run` in the
  foreground, so systemd supervises it. It wants and starts after
  [`deploy/imp-docker-proxy.service`](../../deploy/imp-docker-proxy.service), the only Docker socket
  imp-host sees ([the Docker socket](../architecture/host-contract.md#the-docker-socket)).

  ```sh
  install -m 0644 deploy/imp-host.service deploy/imp-docker-proxy.service /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now imp-docker-proxy imp-host
  ```

- **Compose:** [`deploy/compose.yaml`](../../deploy/compose.yaml), with a Docker restart policy.
  Needs Docker Compose 2.24 or later, for the `env_file` entry with `path` and `required`.

  ```sh
  export IMP_DOCKER_GID=$(stat -c %g /var/run/docker.sock)   # the proxy joins this group
  docker compose -f deploy/compose.yaml up -d
  ```

  The file runs `imp-docker-proxy` beside imp-host. Put `IMP_DOCKER_GID` in a `.env` next to the
  file to keep it. The proxy never reads the env file, so a changed `IMP_BUILD_CONTEXT_MAX_MIB` goes
  in that `.env` too.

  Compose does not read the host's addresses into `IMP_HOST_ADDRESSES`, as the unit does at each
  start. With `public` imps, list the host's addresses and networks (`ip -o addr show scope global`)
  in `IMP_EGRESS_DENY` in the env file ([public](../architecture/networking.md#public)).

  With `IMP_STORAGE_BACKEND=zfs`, add `-f deploy/compose.zfs.yaml` for `/dev/zfs`. On a host booted
  with `ipv6.disable=1`, delete the `net.ipv6` sysctls from the compose file: Docker refuses a
  sysctl the kernel does not have. The systemd unit checks both at each start.

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

`imp image build <dir>` uploads the directory from the machine that runs the CLI, so a checkout on
your laptop is enough ([images](./images.md#build-an-image)):

```sh
imp image build images/base --name base
```

An image from a public registry goes in with `imp image add <ref>`, which pulls it in a builder imp
([add an image](./images.md#add-an-image)).

Until an image named `IMP_DEFAULT_IMAGE` (default `base`) exists, `imp new` uses `ubuntu` and impd
logs a warning at start.

On a new host, impd's first start pulls its builder image (`IMP_BUILD_IMAGE`, the published
`imp-base`, about 700 MB unpacked) by digest onto the host's Docker engine, the one pull
`imp-docker-proxy` lets through, and adds it as `imp-builder`. It then adds `ubuntu` in a builder
imp. Both took 34 to 41 s on a home link. If the builder image does not pull, every add and build
fails with an error that names `IMP_BUILD_IMAGE`; none falls back to the host's engine.
