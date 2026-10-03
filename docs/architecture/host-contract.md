# Host contract

imp runs almost entirely inside the `imp-host` container: impd, Firecracker, tailscaled, and the
nftables rules for the imps' taps. The host under it is thin. This page lists what that host must
give, so any installer can meet it. Two installers exist:

- [`deploy/bootstrap.sh`](../../deploy/bootstrap.sh) for Ubuntu 24.04 and 26.04 and Debian 13
  ([Bootstrap a server](../guides/install.md#bootstrap-a-server)).
- The NixOS module `nixosModules.imp` in imp's flake ([NixOS](../guides/nixos.md)).

## Host requirements

| Need     | What                                                                                                      | Check                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| CPU      | x86_64 with `vmx` or `svm`, and `/dev/kvm`                                                                | `grep -cwE 'vmx\|svm' /proc/cpuinfo`, `test -c /dev/kvm`                  |
| cgroups  | cgroup v2                                                                                                 | `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`                           |
| Docker   | Docker or a compatible engine, with `docker.service` enabled                                              | `systemctl is-enabled docker`                                             |
| Storage  | A ZFS dataset for `IMP_ZFS_ROOT` with `mountpoint=legacy`, or an XFS mount with reflink on `/var/lib/imp` | `zfs get mountpoint tank/imp`, or `xfs_info /var/lib/imp \| grep reflink` |
| sysctls  | `vm.overcommit_memory=1`, `vm.swappiness=1`                                                               | `sysctl vm.overcommit_memory vm.swappiness`                               |
| Modules  | `kvm`, `tun` and `loop`, and `zfs` with ZFS; the ZFS ARC capped by `zfs_arc_max`                          | `lsmod`, `cat /sys/module/zfs/parameters/zfs_arc_max`                     |
| Firewall | Leaves Docker's rules alone and never runs `flush ruleset`                                                | [Firewall](#firewall)                                                     |
| Uplink   | Outbound UDP and HTTPS for the container's tailscaled; nothing inbound                                    | `imp info` shows the tailnet node `Running`                               |

The host's ZFS module must be OpenZFS 2.x; impd warns when its minor version differs from the
image's userland ([versions](./storage.md#versions)).

## RAM

`IMP_RAM_BUDGET_MIB` is the RAM awake imps may use. Both installers set it from `MemTotal`: the host
keeps the larger of 8 GiB and 15 %, and with ZFS also the ARC cap, which is 10 % of RAM within 1 to
8 GiB. The ARC is outside the budget, so a host plan must count both. A value an operator sets
stays. The NixOS module cannot read the RAM size when it is built, so it takes the ARC cap as an
option (`zfs.arcMaxMiB`) and works out the budget at each start.

## What both installers set up

- `/etc/imp/imp-host.env` (0600), from the template, with the backend, the budget,
  `IMP_HOST_FIREWALL` and `IMP_HOST_IPV6`.
- With IPv6, the Docker network `imp-host` on the bridge `br-imphost`, and the host's router adverts
  kept once Docker turns on forwarding ([IPv6](../guides/install.md#ipv6),
  [on NixOS](../guides/nixos.md#ipv6)).
- `/etc/imp/imp-host.seccomp.json`, from the image ([privileges](#privileges)).
- `imp-host.service`, which runs the image with the arguments in
  [`deploy/imp-host.args.json`](../../deploy/imp-host.args.json). `bun run render:deploy` writes
  them into [`deploy/imp-host.service`](../../deploy/imp-host.service) and `bootstrap.sh`, the NixOS
  module reads the file, and a test fails when the unit differs from it. With ZFS it starts after
  the pool is imported.
- `imp-docker-proxy.service`, which imp-host wants and starts after: the only Docker socket imp-host
  sees ([the Docker socket](#the-docker-socket)). Its arguments are the `proxy` section of the same
  file.
- The image: pulled, or loaded from an archive.
- The Tailscale join, inside the container. The node comes back from its saved state in
  `/var/lib/imp/tailscale` when it can, and joins with the key only when it has no state or the
  saved node needs a login ([how it works](../guides/tailscale.md#how-it-works)). `bootstrap.sh`
  puts the key in the env file and blanks it once the node is `Running`
  ([the Tailscale key](../guides/install.md#the-tailscale-key)). The NixOS module never puts it in
  the env file: it mounts the key file into the container read-only
  ([the Tailscale key](../guides/nixos.md#the-tailscale-key)).

## Privileges

The container runs without `--privileged`. `privileges` in
[`deploy/imp-host.args.json`](../../deploy/imp-host.args.json) drops every capability and adds back
the ones below, and the e2e harness fails when the dev instance differs from that list. Each row
says what fails without the capability, from a run with that one capability dropped.

| Capability     | Without it                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `SYS_ADMIN`    | The mounts: storage on `/var/lib/imp`, the cgroup remount, and the jailer's own mount namespace |
| `NET_ADMIN`    | iptables in `setup-net.sh`, the taps and routes                                                 |
| `MKNOD`        | The loop device node, and the jailer's `/dev/kvm` and `/dev/net/tun` in each jail               |
| `CHOWN`        | Image builds: `tar -xp` cannot keep file owners; the jailer's device nodes                      |
| `SETUID`       | The jailer's switch to the imp's uid before it runs Firecracker                                 |
| `SETGID`       | The same, for the gid                                                                           |
| `KILL`         | Stopping a Firecracker that runs as another uid (`firecracker survived SIGKILL`)                |
| `SYS_PTRACE`   | Reading a jailed VM's `/proc/<pid>/smaps_rollup`: its RAM reads 0                               |
| `DAC_OVERRIDE` | Removing another uid's rootfs dirs after a build (`/home/ubuntu`); the jail's `firecracker.log` |
| `FOWNER`       | Image builds: `tar -xp` cannot set modes on files it does not own                               |
| `FSETID`       | Silent: image builds lose the setgid bit of a file whose group is not root                      |
| `SETFCAP`      | Image builds fail on an image with a file capability: tar cannot set `security.capability`      |

For `MKNOD` and `DAC_OVERRIDE`, the dev instance's loop file and an image build fail first; the
jailer's steps in those rows come from its code, not from that run.

`NET_RAW`, `NET_BIND_SERVICE` and `SYS_CHROOT` are not needed: every suite passes without each.
Docker opens ports below 1024 to the container's own namespace, and the jailer pivots its root
instead of calling `chroot`.

`SETFCAP` lets an image keep a file capability, such as `ping`'s `cap_net_raw` or a server's
`cap_net_bind_service`: tar restores `security.capability` as it unpacks the image. Without it, tar
only warns, so impd fails the image add or build with an error that names `CAP_SETFCAP`, and logs a
warning at start. What it adds: root in imp-host can write a file capability, any capability at all,
onto a file it can write. `DAC_OVERRIDE` already lets it write every file on its mounts, so it can
stamp, for instance, `cap_sys_admin+ep` on a binary under `/var/lib/imp`. The bounding set does not
limit what is written: the file's metadata can name any capability. It limits only what a process
gains when it runs the file. In imp-host that set is the list above, so a process there gains
nothing root there lacks. A process outside imp-host has its own bounding set, the full set for a
host process, so the host keeps such files inert: bootstrap mounts `/var/lib/imp` with `nosuid`,
which ignores setuid bits and file capabilities, and warns when an existing mount lacks it; the
NixOS guide asks for the same option. On ZFS, the datasets are mounted inside the container, where
the host's mount table does not see them. impd unpacks an image in a 0700 directory, so no host user
reaches its files during a build. imp-host is not a security boundary against its own root;
`SETFCAP` adds one more way for that root to leave the host a privileged file, next to the setuid
files it can already write.

The rest of the list:

- **Devices:** `/dev/kvm` and `/dev/net/tun`. The dev instance (`scripts/dev.sh`) also gets
  `/dev/loop-control` and the rule `b 7:* rmw` for its loop-mounted XFS file. That rule opens every
  loop device on the machine, the host's included.
- **Probed:** each `probed` entry goes in only where its path exists. The unit checks at each start
  (an `ExecStartPre` writes `/run/imp-host/probed.env`), and the NixOS module decides from its
  config. `/dev/zfs` is one; the `net.ipv6` sysctls are the other, absent on a host booted with
  `ipv6.disable=1`.
- **sysctls:** `/proc/sys` is read-only, so `net.ipv4.ip_forward` and the IPv6 defaults for new taps
  are set by `--sysctl`. The scripts and impd only check them. Read-only stops a write by accident,
  not a deliberate one (see the caution below).
- **cgroups:** `--cgroupns=private`. `setup-cgroups.sh` remounts the container's own
  `/sys/fs/cgroup` read-write; the namespace keeps it to the container's subtree. If the remount
  fails, the container still starts with limits off and jailed VMs cannot start; `imp info` then
  says `limits OFF`.
- **AppArmor:** `unconfined`. Docker's default AppArmor profile denies `mount`.
- **seccomp:** [`deploy/imp-host.seccomp.json`](../../deploy/imp-host.seccomp.json), installed in
  `/etc/imp`. It is Docker's default profile with one rule added: `pivot_root` with `SYS_ADMIN`,
  which the jailer needs and the default denies. When Docker's default changes, copy it again from
  [moby/profiles](https://github.com/moby/profiles/blob/main/seccomp/default.json), append the rule,
  and update the commit and hash in `scripts/imp-host-seccomp.test.ts`. The image ships the profile,
  and `bootstrap.sh` and `upgrade.sh` install it from the image they run.

**CAUTION:** The container is not a security boundary. Root in it can become root on the host by
more than one path, so treat code that gets root in the container as root on the host:

- **The Docker socket: closed by [the proxy](#the-docker-socket).** imp-host has no `docker.sock` of
  the host's. Its socket is imp-docker-proxy's, which refuses a privileged container, a bind mount
  and every other call impd does not make. That closes this path, and only this one.
- **`SYS_ADMIN` in the host's user namespace.** With AppArmor unconfined and Docker's default
  seccomp, which allows `mount` under `SYS_ADMIN`, root can mount a new procfs or sysfs. It can then
  write `kernel.core_pattern` or `uevent_helper` there, and the host kernel runs that program as
  root. The read-only `/proc/sys` above does not stop this: it only stops a write by accident.

Dropping `--privileged` stops accidents, not an escape: the container sees only the devices above,
cannot load kernel modules (`SYS_MODULE`), cannot do raw I/O (`SYS_RAWIO`), cannot read files past
their modes by handle (`DAC_READ_SEARCH`), and cannot write the host's sysctls or cgroups by
mistake. A real boundary needs the container to run without `SYS_ADMIN` in the host's user
namespace, which the jailer's mounts need today.

## The Docker socket

impd builds, pulls and exports images with the `docker` CLI. imp-host does not mount the host's
`/var/run/docker.sock`. A second container from the same image, `imp-docker-proxy`, holds it and
serves `/run/imp-docker/docker.sock`. imp-host mounts `/run/imp-docker` read-only and sets
`DOCKER_HOST` to that socket.

**CAUTION:** The proxy closes the Docker socket path only. imp-host keeps `SYS_ADMIN`, and root in
it can still become root on the host through a new procfs and `core_pattern`
([privileges](#privileges)). The container is still no security boundary.

The proxy, [`packages/daemon/src/docker-proxy/`](../../packages/daemon/src/docker-proxy/), lets
through the calls impd's CLI makes and refuses every other with a 403 and a log line:

| Call                                                     | What passes                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEAD`/`GET /_ping`, `/version`                          | As they are                                                                                                                                                                                                                  |
| `GET /images/{name}/json`                                | As it is                                                                                                                                                                                                                     |
| `POST /images/create` (pull)                             | `fromImage` and `tag` only, an empty body. Not a registry named `localhost` or by an IP address (by name only: see below), and not the repository of `IMP_HOST_IMAGE`, so a pull cannot move the tag both containers run     |
| `POST /build`                                            | The classic builder (`version=1`). Every `t` is `imp/<name>:latest`; `dockerfile` is a path in the context; `buildargs` holds only `BUILDKIT_SYNTAX=docker/dockerfile:1`; `q`, `rm`, `forcerm`. Every other param is refused |
| `POST /containers/create`                                | Only `<image> /bin/true` at the CLI's defaults. The engine gets a body the proxy builds: that image, `/bin/true`, network `none`, and a label with the proxy's token                                                         |
| `GET /containers/{id}/export`, `DELETE /containers/{id}` | Only a container whose label holds the proxy's token, by its full ID. `rm` forwards `force=1&v=1`                                                                                                                            |

- **Paths:** Bun resolves `.`, `..` and `\` before the proxy sees a path. The proxy refuses a path
  that still has `%` or `//`, strips one `/v1.NN` prefix, and checks what is left. It sends the
  engine a new request with that same path, the checked query, and only `Content-Type`,
  `X-Registry-Auth` and `X-Registry-Config`.
- **No start route:** a container the proxy creates never runs. No `Upgrade`, so no attach, exec or
  BuildKit session.
- **The token:** made once, in `/var/lib/imp-docker-proxy/token` (0600), which only the proxy
  mounts. An image cannot carry it, because imp-host never sees it.
- **Bodies:** a build context streams through, up to `IMP_BUILD_CONTEXT_MAX_MIB`; a create body is
  capped at 1 MiB, chunked or not. A 500 MB context and a 3.2 GB export take the same time through
  the proxy as direct, and the proxy stays near 43 MB of memory.
- **The container:** the same image, as uid and gid 65534 plus the group of the host's socket, with
  `--cap-drop ALL`, `no-new-privileges`, a read-only root and `--network none`. It gets
  `IMP_HOST_IMAGE` and `IMP_BUILD_CONTEXT_MAX_MIB` by name, never the env file and its Tailscale
  key. `/run/imp-docker` (0700) belongs to 65534; imp-host's root reaches the 0600 socket through
  `DAC_OVERRIDE`. If the socket's group does not let the proxy in, its unit fails to start.
- **Units:** `imp-host.service` has `Wants=` and `After=` on the proxy, not `BindsTo=`. A proxy that
  stops fails image work only; running imps keep running. The proxy unit waits up to 30 s for its
  socket and restarts always. Compose has a healthcheck and `depends_on`; the NixOS module loads the
  image in `imp-host-image.service`, which both units need.

What stays open through the proxy, by design or until later work:

- A build runs any Dockerfile steps in a default build container. `RUN curl` reaches the host
  through the bridge gateway, and `FROM 127.0.0.1:5000/x` in a Dockerfile goes around the pull rule,
  because the classic builder pulls it itself.
- The pull rule reads the registry's name, not its address. The engine resolves a hostname that
  points into `127.0.0.0/8` and treats that registry as insecure, so a pull from such a name reaches
  a registry on the host's loopback.
- A build has no memory limit and may use all host RAM; a pull can fill the disk.
- The classic builder is deprecated upstream. When the engine drops it, builds stop; BuildKit
  through the proxy is later work.

## Firewall

The host needs no inbound port for imp. impd listens on `127.0.0.1:7070` and `127.0.0.1:7080`, and
tailnet traffic reaches it inside the container's network namespace, through the container's own
tailscaled. impd's own nft tables (the imps' forwarding and NAT) live in that namespace too, so the
host's firewall never sees them.

`IMP_HOST_FIREWALL` says who owns the host's inbound firewall:

- **`own`** (the default of `bootstrap.sh`; `hostFirewall = "own"` in the NixOS module): imp loads
  the `inet imp_host` table, an input chain with policy drop that admits SSH, ICMP and DHCP only
  ([Firewall](../guides/install.md#firewall)). In nftables a drop in any base chain wins, so this
  table blocks whatever another firewall on the host allows. The NixOS module therefore refuses
  `own` beside `networking.firewall.enable`.
- **`none`** (the default of the NixOS module, or `bootstrap.sh --host-firewall none`): imp adds no
  host rules. The platform's firewall decides, such as NixOS `networking.firewall`, and other
  services on the host, such as a host tailscaled or k3s, keep the ports it opens.

Either way, the host's firewall must leave Docker's rules alone. A `flush ruleset` on reload, as
Debian's default `/etc/nftables.conf` does, removes the NAT that the container's traffic leaves
through. With `own`, `bootstrap.sh` refuses an enabled `nftables.service`; with `none`, it warns
when that service's `/etc/nftables.conf` flushes the ruleset. The NixOS module refuses
`networking.nftables.flushRuleset = true`.

The firewall must also forward the container's traffic out. Docker admits it in its own chains, but
a firewall that filters forwarding, such as NixOS with `networking.firewall.filterForward = true`,
drops it unless a rule admits imp-host's bridge: `br-imphost` with IPv6, else `docker0`. The NixOS
module adds that rule and trusts no interface for input. Imps then reach no host service through the
bridges for as long as the host's input filter drops traffic from them: with `own` the `imp_host`
table does, and with `none` it is the platform's firewall ([forwarding](../guides/nixos.md#ipv6)).
