# Guest agent and kernel

Every imp guest runs `imp-agent`, a static Go binary, as PID 1. It comes from a read-only system
drive, not from the user's image, so any OCI image boots with no imp bits in it. The agent mounts
the filesystems, sets up the network, supervises services, reaps zombies, and serves the
[agent protocol](./protocol.md) on vsock. The code is in `agent/`.

## Two drives

- `vda` is the user rootfs (ext4, read-write), a clone of an image ([storage](./storage.md)).
- `vdb` is the imp system drive (squashfs, read-only). It holds `imp-agent`. The `agent` stage of
  `host/Dockerfile` builds it, for the release image and, through `scripts/build-system-drive.sh`,
  for the dev instance: the same bytes either way.

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

1. Mount cgroup2, `/dev/pts` and `/dev/shm`.
2. Set the hostname, bring up loopback and `eth0` through netlink, and write `/etc/resolv.conf`.
3. Start the services in `/etc/imp/services.d` ([images guide](../guides/images.md#services)).
4. Listen on vsock port 1024.

`/run` is a tmpfs every boot, so stale pid files and sockets from the last boot never reach a new
one. Services need no cleanup of their own: `imp/base` runs `dockerd` directly, with no wrapper.

## The reaper

The agent is PID 1, so it inherits every orphan in the guest and must reap it. One loop owns every
`wait4` call. A per-child `Wait` would race with that loop, so nothing else in the agent calls
`cmd.Wait`. Code that spawns a process registers its pid and gets the exit status from the reaper.

## Exec and services

`exec` starts a process with the image's default environment (`/etc/imp/image.json`), on pipes or on
a new pty. The [protocol](./protocol.md#exec) has the full rules. The service supervisor starts each
file in `/etc/imp/services.d`, logs to `/var/log/imp/<name>.log`, and restarts a service that exits,
with backoff.

## Sessions

A session keeps a program on a pty alive without a host connection
([protocol](./protocol.md#sessions)). One goroutine per session reads the pty into a history buffer
and into the attached viewer's queue, and never waits for the viewer. The history keeps the last
256–512 KiB of raw output. A VT parser (`charmbracelet/x/ansi`) reads the output that the history
drops, so the history knows the terminal modes in effect where its kept output starts, and cuts it
between escape sequences.

Each session holds up to 512 KiB of history and a 2 MiB queue for its viewer. Input waits in a queue
of 4 STDIN frames before the pty, at most 4 MiB when the host sends frames of the 1 MiB maximum;
typed input is a few bytes a frame. With the cap of 16 sessions, the worst case per imp is about 40
MiB of output buffers and 64 MiB of input, before the programs' own memory.

The history sits behind a `Screen` interface. A terminal emulator that keeps the cell grid (such as
`charmbracelet/x/vt`) could replace it, so that a replay shows the screen as it is instead of raw
output that the program must redraw over. Sessions live in the agent's memory: they survive a sleep
and wake, and end with the guest.

## Dial, SFTP, agent forwarding and reverse forwards

These pieces serve impd's [SSH gateway](../guides/ssh.md). The `dial` op connects to an address in
the guest and relays bytes, for port forwarding ([protocol](./protocol.md#dial)); a unix socket dial
runs `imp-agent dial-unix` as the image's user, which hands the connected socket back. And
`imp-agent tar`, the guest end of `imp cp` ([copying files](../guides/cp.md)), runs from the system
drive through a plain `exec`, as root. `imp-agent sftp`, run from the system drive as
`/run/imp/sys/imp-agent sftp`, is an SFTP server on stdin and stdout (`github.com/pkg/sftp`). impd
starts it through a plain `exec`, as the image's user, so every image gets SFTP without an
`sftp-server` of its own. It starts in `$HOME`. And `agent.listen` serves a socket for
`SSH_AUTH_SOCK` under `/run/imp/ssh-agent/`, owned by the image's user, for as long as impd keeps
the connection open; `agent.accept` relays each of its clients to the user's ssh-agent. `listen`
serves a reverse forward the same way, at a path or port the host names, bound by
`imp-agent listen-as-user` as the image's user, which hands the listening socket back
(`internal/listen`, [protocol](./protocol.md#listen)).

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
