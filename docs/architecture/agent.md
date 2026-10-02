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
parameters from impd: `imp.id`, `imp.hostname`, `imp.ip`, `imp.gw` and `imp.dns`;
`imp.reset_identity=1` on the first boot of an imp made from a
[template](../guides/templates.md#identity); and with IPv6, `imp.ip6` and `imp.gw6`
([IPv6](./networking.md#ipv6)), which an older agent ignores.

## Boot

The agent stays on the system drive, its own world, and runs every user process in the inner
container over the user disk:

1. Mount `/proc`, `/sys`, `/dev`, cgroup2 (`nsdelegate`), a 16 MiB tmpfs on `/run` and its own
   `/dev/pts`.
2. Set its own `oom_score_adj` to -1000, and make `/sys/fs/cgroup/user` with every controller and a
   `memory.max` of the guest's memory less 64 MiB. A [boot template](./boot-templates.md#make) parks
   after this step, and goes on with its claim's values instead of the kernel command line.
3. Mount `vda` on `/user`, and grow its filesystem if the host grew the disk.
4. Set the hostname and bring up loopback and `eth0` through netlink. With `imp.ip6`, turn off
   router advertisements and redirects on `eth0`, add the address with no duplicate address
   detection, and add a default route via `imp.gw6`.
5. Start the [inner container](#the-inner-container), then write `/etc/hostname`, `/etc/hosts` and
   `/etc/resolv.conf` in it and read `/etc/imp/image.json`. With `imp.reset_identity=1`, write a new
   machine-id and new ssh host keys in it, with the image's `ssh-keygen` run inside.
6. Start the services in `/etc/imp/services.d` ([images guide](../guides/images.md#services)).
7. Listen on vsock port 1024.

The agent never execs itself on the way: on a restored template, a new runtime would fault in every
page it touches.

The inner `/run` is a fresh tmpfs at each start, so stale pid files and sockets from the last boot
never reach a new one. Services need no cleanup of their own: `imp/base` runs `dockerd` directly,
with no wrapper.

## The inner container

User code runs in a container whose root is the user disk: its own mount, PID and cgroup namespaces,
sharing the network and the hostname with the agent. Its PID 1 is `imp-agent inner`, which the agent
starts with `clone3` into `/sys/fs/cgroup/user`. The inner init:

1. Makes `/` private and binds `/user` onto itself.
2. Mounts on it a fresh `/proc`, `/sys`, cgroup2, a tmpfs `/dev` with a copy of the agent's device
   nodes, `/dev/pts` (a new instance), `/dev/shm`, and a tmpfs `/run` of a tenth of memory.
3. Binds the system drive read-only at `/run/imp/sys`, without the agent's mounts under it, so
   `/run/imp/sys/imp-agent sftp|tar|dial-unix|listen-as-user` work in any image.
4. Calls `pivot_root` into it and detaches the old root, so nothing of the agent's world stays
   reachable.
5. Moves itself into `/init`, a leaf, and enables every controller at its cgroup namespace's root.
   That root then holds no process, and `dockerd` can make its cgroups under it.
6. Serves the agent on a `SOCK_SEQPACKET` socket: spawn, signal, and exit reports. The fds of a
   spawn travel as `SCM_RIGHTS`.

A Go process cannot `setns` into a mount namespace, so the inner init forks every user process for
the agent. Each exec still gets [its cgroup](#exec-cgroups), under `user/exec`. The agent opens the
inner init's root at each start, and reads and writes user files only through
`openat2(RESOLVE_IN_ROOT)` on it: a symlink planted in the user's files cannot lead out. The inner
init ignores every signal it can, as the kernel delivers to a namespace's init only the signals it
handles, and Go handles nearly all of them. `kill -TERM 1` inside does nothing.

When the inner init dies (a `reboot` inside, say), every process in the container dies with it. The
agent ends the waits of what ran there, closes the sockets it served on a tmpfs inside (`/run`,
`/dev`), whose files went with it, ends the services' supervision, and starts the container again
after 1 s, doubling to 30 s. TCP ports and sockets on the user disk stay open. Each new container
gets its `/etc` files written and its image config read again, and its services started. A start
that fails, or a container that dies within a minute of its start, is a bad start: after more than 5
in 10 minutes the agent gives up until the next boot, `ping` reports the container down with the
last error, and a spawn fails with `INNER_DOWN`. A container that ran a while starts again however
often it dies.

After `rm -rf /` inside, the container stays up but has nothing to run: an exec fails at once with
`EXEC_FAILED`. A checkpoint restore brings the files back. If the init then dies, the container
starts again over the empty root: the init is the agent binary from the system drive, and it makes
its own mount points.

The inner init's socket is close-on-exec, so no process it starts holds it, and it sets its own
`oom_score_adj` back to 0 before it starts anything: the agent's -1000 must not reach the
container's processes, or a memory hog would hang the guest instead of being killed. It runs each
spawn on its own, and the agent gives a request 30 s: one spawn that hangs (a stat on a dead FUSE
mount) holds neither the others nor a kill. The agent's reads of the user's files take regular files
only, opened without blocking, so a FIFO at `/etc/hosts` cannot hold the boot.

Helpers and impd's runs of the agent by its system drive path start from an fd the inner init opened
before the pivot, so they work with `/run/imp/sys` unmounted inside. The guest kernel (6.1) left a
cgroup once killed with `cgroup.kill` killing the next process cloned into it, so the agent ends the
container by killing its init, never with `cgroup.kill`.

### Not a security boundary

The container keeps user processes from taking the agent down by accident: `rm -rf /`, `kill -9 -1`,
a reboot, a full memory. It does not keep root inside from reaching the agent on purpose. The guest
is the user's own; the VM is the boundary. Root inside holds every capability in the one user
namespace, so it can open `/dev/vda` (its own disk), write `/proc/sysrq-trigger`, change sysctls,
and mount what it likes. The guest kernel has `CONFIG_MODULES` off, so there is no module to load; a
kernel with modules would add that route.

## The reaper

The agent is PID 1, so it inherits every orphan in the guest and must reap it. One loop owns every
`wait4` call. A per-child `Wait` would race with that loop, so nothing else in the agent calls
`cmd.Wait`. Code that spawns a process registers its pid and gets the exit status from the reaper.

## Exec and services

`exec` starts a process with the image's default environment (`/etc/imp/image.json`), on pipes or on
a new pty. The [protocol](./protocol.md#exec) has the full rules. The service supervisor starts each
file in `/etc/imp/services.d`, logs to `/var/log/imp/<name>.log`, and restarts a service that exits,
with backoff. The services ops add, restart and remove a service and stream its log
([protocol](./protocol.md#servicesadd-servicesremove-servicesrestart)), behind `imp service` and
`imp logs` ([services](../guides/services.md)).

### Exec cgroups

Each non-tty exec starts in a cgroup v2 leaf of its own, `/sys/fs/cgroup/user/exec/<n>` (`/exec/<n>`
inside the container), through `clone3` with `CLONE_INTO_CGROUP`, so no child can fork before it is
inside. A stop kills the leaf with `cgroup.kill` ([protocol](./protocol.md#exec)). The parent holds
no process and enables no controller. A leaf goes when its exec ends, or later, once a child it left
behind (a `nohup` job) exits: the next exec sweeps only the leaves of ended execs. When the leaf or
the spawn into it fails, the agent logs it once and the exec runs without one, as before. When the
write to `cgroup.kill` fails, the stop sends SIGKILL to the process group instead.

A command runs as root unless the image says otherwise, so it can move itself out of its leaf, and a
`dockerd` started from an exec puts its containers in cgroups of its own; a stop does not reach
those. A tty exec has no leaf: its session leader owns the terminal's process group.

## Sessions

A session keeps a program on a pty alive without a host connection
([protocol](./protocol.md#sessions)). One goroutine per session reads the pty into a history buffer
and into the attached viewer's queue, and never waits for the viewer. The history keeps the last
256–512 KiB of raw output. A VT parser (`charmbracelet/x/ansi`) reads the output that the history
drops, so the history knows the terminal modes in effect where its kept output starts, and cuts it
between escape sequences. Apart from it, a raw ring keeps exactly the last 256 KiB, which a resume
reads by offset ([output offsets](./protocol.md#output-offsets)). Each start of the process is a new
generation, and the agent keeps the last one that ended under each name as `previous`.

Each session holds up to 512 KiB of history, the 256 KiB ring and a 2 MiB queue for its viewer.
Input waits in a queue of 4 STDIN frames before the pty, at most 4 MiB when the host sends frames of
the 1 MiB maximum; typed input is a few bytes a frame. With the cap of 16 sessions, the worst case
per imp is about 44 MiB of output buffers and 64 MiB of input, before the programs' own memory.

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

On `shutdown` the agent thaws the user disk, stops the services, signals every other process, kills
the inner init so the container does not start again, syncs, remounts `/user` read-only and reboots.
With `reboot=k` on the command line, that makes Firecracker exit.

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
