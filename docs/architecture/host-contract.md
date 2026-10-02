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
drops it unless a rule admits `docker0`, and `br-imphost` with IPv6. The NixOS module adds that rule
and trusts no interface for input, so imps reach no host service through the bridges
([forwarding](../guides/nixos.md#ipv6)).
