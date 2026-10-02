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
   export IMP_TOKEN=$(scripts/dev.sh token)
   ```

   Or write it to `~/.config/imp/token` once.

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

- Builds the `dev` target of `host/Dockerfile` as the host image, and `build/imp-system.squashfs`
  (the agent's system drive) when it is missing.
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

[`deploy/bootstrap.sh`](../../deploy/bootstrap.sh) takes a fresh Ubuntu 24.04 or Debian 13 server,
x86_64 with KVM, to a running impd. It is one file with no other repo files, so copy it to the
server and run it as root:

```sh
curl -fsSLO https://raw.githubusercontent.com/zgeoff/imp/main/deploy/bootstrap.sh
install -m 0600 /dev/null /root/ts-key && vi /root/ts-key        # the auth key, one line
bash bootstrap.sh --dry-run --data-device /dev/nvme1n1 --tailscale-authkey-file /root/ts-key
bash bootstrap.sh --yes --data-device /dev/nvme1n1 --tailscale-authkey-file /root/ts-key
```

`--dry-run` prints every change and makes none. `--check` does the same and exits 1 when a change is
pending. A run changes only what differs from what it wants, so a second run changes nothing.

**CAUTION:** `--data-device` formats the device. The script refuses a device that is mounted, has
partitions, is a RAID or LVM member, holds the root filesystem, or has any signature but XFS. Check
the device name with `lsblk` before the run all the same.

The phases run in order:

- **preflight:** Checks root, the OS, x86_64, `/dev/kvm` and `vmx`/`svm`, before any change.
- **packages:** Installs `xfsprogs`, `nftables`, `jq` and Docker CE from Docker's apt repo. A Docker
  that is already installed stays.
- **storage:** Makes `--data-device` XFS with reflink (fstab by UUID), or creates the `--loop-file`
  on the root filesystem (fstab `loop`). Mounts it on `/var/lib/imp`. With `/var/lib/imp` already
  mounted, it only checks it is XFS with reflink.
- **kernel:** Writes `vm.overcommit_memory = 1` and `vm.swappiness = 1` to
  `/etc/sysctl.d/90-imp.conf`, and `kvm`, `tun` and `loop` to `/etc/modules-load.d/imp.conf`, and
  applies both. Swap stays as the installer made it.
- **firewall:** Disables `ufw` and `firewalld`, and loads `/etc/imp/firewall.nft` with
  `imp-firewall.service`. It refuses while `nftables.service` is enabled.
- **imp:** Writes `/etc/imp/imp-host.env` (0600) and `/etc/systemd/system/imp-host.service`, pulls
  the image (or loads `--image-archive`), and starts the unit.
- **health:** Waits for `imp info`, checks that `imp-host` publishes ports on `127.0.0.1` only, then
  creates, runs `uname -a` in, and destroys an imp from `ubuntu`. `--skip-health` skips it.

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
does not partition disks.

`--loop-file /srv/imp.xfs --loop-size 400` puts a sparse XFS file on the root filesystem instead. It
needs 20 GiB free and puts a loop device in the I/O path; use it only when no disk or partition is
free.

The storage phase has one backend today, XFS. ZFS ([#11](https://github.com/zgeoff/imp/issues/11))
adds a second.

### RAM budget

The script sets `IMP_RAM_BUDGET_MIB` to the RAM the kernel reports, less the larger of 8 GiB and 15
%. The host keeps that for itself, Docker, impd and the page cache. On a 64 GB box:

| What                                    | MiB    |
| --------------------------------------- | ------ |
| MemTotal (64 GB reports about 62.5 GiB) | 64,000 |
| Kept for the host: max(8192, 15 %)      | 9,600  |
| `IMP_RAM_BUDGET_MIB`                    | 54,400 |

That is about 170 awake imps at the 317 MiB that `STATUS.md` measured for an imp filling 256 MiB, or
26 at 2 GiB each fully used. Sleeping imps cost disk, not RAM.

The script writes the budget when the env file holds the template's `16384` or nothing. Any other
value is yours and stays. With ZFS, cap `zfs_arc_max` and take the ARC out of the budget too.

### The Tailscale key

The key goes to `/etc/imp/imp-host.env` only, and is never printed. The host container is the
tailnet node; the host OS stays off the tailnet, and you reach it over public SSH.

Use a tagged, non-ephemeral, single-use key ([Tailscale guide](./tailscale.md)). After the first
start the node keeps its state in `/var/lib/imp/tailscale`, so the spent key cannot join anything
again. Leave it in the env file: `tailscale-up.sh` does nothing without a key, so a blank key keeps
the node offline after the next restart.

### Firewall

The `inet imp_host` table filters input only: loopback, established connections, ICMP and ICMPv6,
the DHCP clients, and SSH. Docker keeps the forwarding rules, and a reload replaces this table
alone. The SSH ports are those `sshd -T`, `ssh.socket` and the live `sshd` listeners report, plus
`--ssh-port`. The script refuses the run when the current SSH session's port is not among them, and
warns when `sshd` allows password logins.

### Test it

`scripts/test-bootstrap.sh` runs the script in a privileged container with systemd as PID 1, on
Debian 13 and Ubuntu 24.04, with a loop file and Docker inside. It checks `--check` on the fresh
host, a first run, `--check` and a second run with no change. It fails when the host's `vm.*` and
`kernel.*` sysctls or loaded modules change. In a container, the script writes the kernel settings
and does not apply them.

```sh
scripts/test-bootstrap.sh --stub                              # a stand-in image (what CI runs)
scripts/test-bootstrap.sh --image imp-host:<tag> --health     # a release image; boots an imp
```

Nothing has run on a real OVH or Vultr server yet.

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
stages, so the dev instance boots the same bytes as the release image. A snapshot of a sleeping imp
restores only with the kernel and drive it was taken on, so this is what lets an upgrade that leaves
them alone keep every imp's memory. Only these two files are reproducible; the image digest is not
(apt packages, timestamps and the compiled impd differ per build).

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
