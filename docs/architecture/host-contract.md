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

For `MKNOD` and `DAC_OVERRIDE`, the dev instance's loop file and an image build fail first; the
jailer's steps in those rows come from its code, not from that run.

`NET_RAW`, `NET_BIND_SERVICE` and `SYS_CHROOT` are not needed: every suite passes without each.
Docker opens ports below 1024 to the container's own namespace, and the jailer pivots its root
instead of calling `chroot`. `SETFCAP` is not needed either: image builds restore only `user.*`
extended attributes (`tar --xattrs` without `--xattrs-include`), so a file capability such as
`ping`'s `cap_net_raw` is lost with or without it. Restoring them would take both.

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
  `/sys/fs/cgroup` read-write; the namespace keeps it to the container's subtree.
- **AppArmor:** `unconfined`. Docker's default AppArmor profile denies `mount`.
- **seccomp:** [`deploy/imp-host.seccomp.json`](../../deploy/imp-host.seccomp.json), installed in
  `/etc/imp`. It is Docker's default profile with one rule added: `pivot_root` with `SYS_ADMIN`,
  which the jailer needs and the default denies. When Docker's default changes, copy it again from
  [moby/profiles](https://github.com/moby/profiles/blob/main/seccomp/default.json), append the rule,
  and update the commit and hash in `scripts/imp-host-seccomp.test.ts`. The image ships the profile,
  and `bootstrap.sh` and `upgrade.sh` install it from the image they run.

**CAUTION:** The container is not a security boundary. Root in it can become root on the host by
more than one path, so treat code that gets root in the container as root on the host:

- **The Docker socket.** It can start a privileged container. A socket proxy that allows only the
  calls impd makes ([#83](https://github.com/zgeoff/imp/issues/83)) would close this path, and only
  this one.
- **`SYS_ADMIN` in the host's user namespace.** With AppArmor unconfined and Docker's default
  seccomp, which allows `mount` under `SYS_ADMIN`, root can mount a new procfs or sysfs. It can then
  write `kernel.core_pattern` or `uevent_helper` there, and the host kernel runs that program as
  root. The read-only `/proc/sys` above does not stop this: it only stops a write by accident.

Dropping `--privileged` stops accidents, not an escape: the container sees only the devices above,
cannot load kernel modules (`SYS_MODULE`), cannot do raw I/O (`SYS_RAWIO`), cannot read files past
their modes by handle (`DAC_READ_SEARCH`), and cannot write the host's sysctls or cgroups by
mistake. A real boundary needs the container to run without `SYS_ADMIN` in the host's user
namespace, which the jailer's mounts need today.

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
