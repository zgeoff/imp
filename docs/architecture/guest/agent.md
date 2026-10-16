# The guest agent

Every guest runs one program as PID 1, the imp agent, a static Go binary. It comes from a read-only
system drive, not from the user's image, so any OCI image boots with nothing of impz in it. The
agent mounts the guest's filesystems, brings up its network, runs the user's processes in an inner
container, supervises services, reaps orphans, and serves impd over vsock
([the agent protocol](./protocol.md)). The code is `agent/`.

## Two drives and a kernel

A guest gets two drives. The first is the user's disk, an ext4 clone of an image that the guest
reads and writes ([storage](../storage/storage.md)). The second is the system drive, a squashfs that
holds the agent and a static busybox, built to the same bytes for the release image and a dev
instance alike. The kernel boots with the system drive as its root and the agent as its init, with
no initramfs, and impd passes the imp's hostname, addresses and DNS on the kernel command line.

impz builds its own guest kernel, a 6.1 LTS kernel from Firecracker's microVM config plus a fragment
of everything a current Docker needs: nftables, the iptables raw table, IPVS, the overlay network
drivers, TUN and FUSE. The microVM config lacks those, and has modules off, so nothing missing could
be loaded later. Everything is built in, and nothing loads modules. AppArmor stays off, because with
it on dockerd expects profiles inside the guest image. `kernel/README.md` has the build.

## Boot

The agent stays on the system drive, in a world of its own, and runs every user process in the inner
container over the user disk.

1. It mounts its own `/proc`, `/sys`, `/dev`, cgroup2 and a small `/run`. It sets its own OOM score
   so that the kernel never picks it, and makes the cgroup for user code, with a memory limit a
   little under the guest's memory. A [boot template](../lifecycle/boot-templates.md) parks here and
   takes its claim's values from then on.
2. It mounts the user disk, and grows its filesystem when the host grew the disk.
3. It sets the hostname and brings up loopback and the network device.
4. It starts the inner container, writes the container's hostname, hosts and resolver files, and
   reads the image's config for the default environment. On the first boot of an imp made from a
   template image it writes a new machine-id and new SSH host keys.
5. It starts the services, makes the cgroups for execs and outer execs, and listens on vsock.

The agent never execs itself on the way, because on a restored template a new runtime would fault in
every page it touches.

## The inner container

User code runs in a container whose root is the user disk, with its own mount, PID and cgroup
namespaces, and the agent's network and hostname. Its PID 1 is the agent binary again, in an inner
mode: it pivots into the user disk, mounts fresh `/proc`, `/sys`, `/dev` and `/run` there, binds the
system drive read-only at `/run/imp/sys`, and then forks every user process for the agent over a
socket, since a Go process cannot join a mount namespace. Inside, the system drive gives every image
the helpers impd runs, such as the SFTP server and the tar of `impz cp`.

The container exists so that user processes cannot take the agent down by accident. `rm -rf /`,
`kill -9 -1`, a reboot inside or a full memory ends the container, not the agent. When the inner
init dies, every process in the container dies with it, and the agent starts the container again
with a growing delay. TCP ports and files on the user disk stay. A container that keeps dying soon
after its start is a bad start, and after several in a short window the agent gives up until the
next boot, reports the container down in its ping, and fails each spawn with `INNER_DOWN`. impd
keeps the latest ping's report in memory for each awake imp, from the ping it sends beside each idle
check, so `impz ls` marks an imp whose container is down and `impz info <name>` shows its restarts
and last error. After an `rm -rf /` the container stays up with nothing to run, and a checkpoint
restore brings the files back.

The agent reads and writes user files only by resolving each path inside the inner root, so a
symlink planted in the user's files cannot lead out, and it opens only regular files without
blocking, so a FIFO at `/etc/hosts` cannot hold the boot.

The container is not a security boundary. Root inside holds every capability in the one user
namespace: it can open its own disk device, change sysctls and mount what it likes. The guest is the
user's own, and the VM is the boundary ([isolation](../isolation.md)).

## Read-only files

impd can place a file in the guest that no process inside can change, root included. The agent keeps
these files in a small tmpfs of its own, outside the inner container, and the inner init binds that
tmpfs read-only at `/run/imp/files` on each container start. Root inside holds every capability, so
the bind is what refuses the write: a write, a remove, a chmod or a new file under it fails with
`EROFS`, where a file of mode 0444 on the user's disk would only ask root to leave it alone. A
caller such as atc uses one to hand a session a record it can read and not forge.

impd writes and removes a file through the agent's `files.write` and `files.remove` ops, which the
API's `files` calls reach, with the same scope as an exec. The agent writes the new content to a
staged file beside the old one and renames it into place, so a reader inside sees the old file or
the new, never part of either. It checks each path against one rule, which impd checks before the
call as well: a few plain segments with no `..` and no leading dot, so no path names a staged file
or leaves the tree. A full tmpfs refuses the write with `NO_SPACE` and leaves the old file as it
was.

The files live in guest memory. A sleep keeps them in the snapshot, and a container restart binds
the same tmpfs again, so both find them in place. A cold boot ends them, and no checkpoint, fork,
template or backup carries them, since none of those copies memory. A caller that needs a file after
a boot writes it again before it starts what reads it.

By default the bind refuses writes, and it is no boundary. Root in the container holds
`CAP_SYS_ADMIN` in the agent's own user namespace, so it can remount the bind writable and change
the files, or unmount it and put files of its own at the path. A changed file lasts until impd
writes it again, because each write replaces the file with a new one; an unmount lasts until the
container starts again. A process that only writes gets `EROFS`.

An exec started with `dropSysAdmin` closes the remount path for its own process tree. The inner init
starts it as a small agent helper, which drops `CAP_SYS_ADMIN` and `CAP_SYS_PTRACE` from its
bounding set and from every other capability set, then becomes the command with the same pid,
terminal and cgroup leaf. Root in that tree gets `EPERM` from a remount or an unmount, and neither
the command nor a setuid binary it runs gets the capabilities back, because an exec takes root's
permitted set from the bounding set. `CAP_SYS_PTRACE` goes with it, because a tracer could otherwise
make a process that still holds `CAP_SYS_ADMIN`, such as the container's init, run the remount. A
new user namespace gives the tree no way back either: the kernel locks the read-only flag on each
mount it copies into a namespace that the tree owns. The image's own start-up runs as services,
outside that tree, so a service such as `dockerd` keeps its capabilities. The tree can still ask
such a service to act for it, for example a privileged container that binds the files, so a caller
that drops the capabilities to protect a file also runs no `dockerd` that the tree can reach. The
tree cannot mount filesystems or start `dockerd` itself. A start that drops the capabilities, for a
session that runs with them, fails with `BAD_REQUEST`, so the caller never attaches to a process
that holds them. impd refuses the option for an agent that cannot drop the capabilities, because
such an agent ignores the field.

## Execs and services

An exec starts a process in the container with the image's default environment, on pipes or a pty.
Each non-tty exec starts inside a cgroup leaf of its own, so that no child can fork before it is
inside, and a stop kills the whole leaf at once. A command runs as root unless the image says
otherwise, so a process can move itself out of its leaf, and the containers of a `dockerd` it
started live in cgroups of their own: a stop does not reach those. A tty exec has no leaf, because
its session leader owns the terminal's process group.

An outer exec runs a command as root in the agent's own world, outside the container, to see why the
container is down or look at the disk after an `rm -rf /` inside. It runs in a small cgroup with a
hard memory limit, or not at all, and resets its OOM score, so the kernel can kill it. Only a caller
with host-wide `manage` scope may start one, and impd audits each. It is no new boundary, since root
inside the container already holds every capability in the guest.

The service supervisor starts each service file in `/etc/imp/services.d` at boot, logs it, and
restarts it with backoff when it exits.

## The reaper

The agent is PID 1, so it inherits every orphan in the guest and must reap it. One loop owns every
wait call, and nothing else in the agent waits on a child, since a per-child wait would race with
it. Code that spawns a process registers its pid and gets the exit status from the reaper.

## Shutdown

On a shutdown the agent thaws the user disk, stops the services, signals every other process, kills
the inner init so the container does not start again, syncs, remounts the user disk read-only and
reboots. The kernel's reboot setting makes that end Firecracker.
