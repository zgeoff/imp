# Guest agent and kernel

Every imp guest runs `imp-agent`, a static Go binary, as PID 1. It comes from a read-only system
drive, not from the user's image, so any OCI image boots with no imp bits in it. The agent mounts
the filesystems, sets up the network, supervises services, reaps zombies, and serves the
[agent protocol](./protocol.md) on vsock. The code is in `agent/`.

## Two drives

- `vda` is the user rootfs (ext4, read-write), a clone of an image ([storage](./storage.md)).
- `vdb` is the imp system drive (squashfs, read-only). It holds `imp-agent`.
  `scripts/build-system-drive.sh` builds it.

The kernel command line is `root=/dev/vdb rootfstype=squashfs ro init=/imp-agent`, plus `imp.*`
parameters from impd: `imp.id`, `imp.hostname`, `imp.ip`, `imp.gw` and `imp.dns`.

## Boot

**Stage 1** runs from the system drive:

1. Mount `/proc`, `/sys` and `/dev`.
2. Mount `vda` on `/newroot`.
3. Mount a fresh tmpfs on `/newroot/run`, and bind the system drive to `/newroot/run/imp/sys`.
4. Move `/dev`, `/proc` and `/sys` into the new root, `switch_root` to it, and re-exec
   `/run/imp/sys/imp-agent stage2`. PID 1 stays the agent.

**Stage 2** runs in the user's root:

1. Set the hostname, bring up loopback and `eth0` through netlink, and write `/etc/resolv.conf`.
2. Mount cgroup2, `/dev/pts` and `/dev/shm`.
3. Start the services in `/etc/imp/services.d` ([images guide](../guides/images.md#services)).
4. Listen on vsock port 1024.

`/run` is a tmpfs every boot, so stale pid files and sockets from the last boot never reach a new
one.

## The reaper

The agent is PID 1, so it inherits every orphan in the guest and must reap it. One loop owns every
`wait4` call. A per-child `Wait` would race with that loop, so nothing else in the agent calls
`cmd.Wait`. Code that spawns a process registers its pid and gets the exit status from the reaper.

## Exec and services

`exec` starts a process with the image's default environment (`/etc/imp/image.json`), on pipes or on
a new pty. The [protocol](./protocol.md#exec) has the full rules. The service supervisor starts each
file in `/etc/imp/services.d`, logs to `/var/log/imp/<name>.log`, and restarts a service that exits,
with backoff.

## Shutdown

On `shutdown` the agent stops the services, signals every other process, syncs, remounts `/`
read-only and reboots. With `reboot=k` on the command line, that makes Firecracker exit.

## Guest kernel

imp guests run a custom 6.1 LTS kernel (`kernel/`), built from Firecracker's CI config plus
`kernel/docker.fragment`. Everything is built in; there are no modules and no initramfs.
`kernel/README.md` has the build commands.

### Why not the Firecracker CI kernel

The CI kernel (6.1.155) boots, but it cannot run a current docker-ce well:

- No `CONFIG_NF_TABLES`. Ubuntu 24.04 `iptables` is iptables-nft by default, so a stock image fails
  until you switch it to iptables-legacy.
- No `CONFIG_IP_NF_RAW` / `CONFIG_IP6_NF_RAW`. Docker 28+ writes raw-table PREROUTING rules to block
  direct access to container IPs.
- No `CONFIG_NETFILTER_XT_MARK` or `CONFIG_NETFILTER_XT_MATCH_IPVS` (listed as required by moby's
  `check-config.sh`), no `TUN` and no `FUSE_FS`.

The CI kernel has `CONFIG_MODULES` off and guests have no initramfs, so the missing parts cannot be
loaded later.

### How the config is made

1. `config-base`: Firecracker's microvm config (a copy of the CI 6.1.155 config).
2. `docker.fragment`: merged on top with `scripts/kconfig/merge_config.sh -m`.
3. `make olddefconfig` fills symbols that are new in the newer 6.1 release.

Every fragment entry is `=y`. Do not add `=m`: nothing loads modules.

### What the fragment adds

- nftables: `NF_TABLES`, `NF_TABLES_INET/IPV4/IPV6/BRIDGE/NETDEV`, `NFT_COMPAT` (iptables-nft xt
  matches), `NFT_NAT`, `NFT_MASQ`, `NFT_CT`, `NFT_FIB*`, `NFT_REJECT*` and related symbols.
- iptables: raw and security tables, `XT_MARK`/`CONNMARK`, `XT_SET` + ipset, `CHECKSUM`, `CT`,
  `NOTRACK`, extra matches (ipvs, bpf, multiport, physdev, comment, owner, recent, statistic),
  ebtables, FTP/TFTP conntrack helpers.
- IPVS (round robin, TCP/UDP) for Swarm and kube-proxy ipvs mode.
- Network drivers: `VLAN_8021Q` + `BRIDGE_VLAN_FILTERING`, `VXLAN`, `IPVLAN`, `MACVLAN`, `DUMMY`,
  `TUN`, `WIREGUARD`, `NET_CLS_CGROUP`, `IP_SCTP`, ESP/GCM for encrypted overlay.
- `CGROUP_MISC`, `FUSE_FS` + `CUSE`, `BTRFS_FS`.
- `RAID6_PQ_BENCHMARK` off (BTRFS pulls in RAID6). The boot-time benchmark cost about 480 ms;
  without it, InstanceStart → agent ping is the same as on the CI kernel (about 450 ms).
- The Firecracker essentials already in the base, pinned so a base change cannot drop them: virtio
  mmio/blk/net, virtio-balloon + `PAGE_REPORTING`, vsock, squashfs xz/zstd, ext4, `IKCONFIG_PROC`.

AppArmor stays off on purpose. With AppArmor on, dockerd expects `apparmor_parser` and profiles
inside the guest image.
