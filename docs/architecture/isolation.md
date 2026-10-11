# Isolation

An imp runs agent code that a prompt injection can take over, so each layer around it says plainly
what it holds back and what it does not. The VM is the boundary between one imp and the rest. The
jailer and the cgroups keep a guest that escapes its VM to its own files and its own resources. The
host container and the inner container stop accidents, not escapes. [The host](./host.md) covers the
container's privileges, and [egress](./network/egress.md) what an imp may reach on the network.

## The VM

Each imp is one Firecracker microVM, so each guest has its own kernel behind KVM, the hardware
boundary. Firecracker over QEMU means a few megabytes of VMM overhead against tens of megabytes,
fast snapshot and restore, and a minimal device model, at the cost of no GPU and no virtiofs. Inside
the guest, root holds every capability, and the user's processes run in an inner container that
keeps them from taking the agent down by accident; the guest is the user's own, and that container
is no boundary ([the agent](./guest/agent.md#the-inner-container)).

KASLR is off in every guest, because Firecracker loads the uncompressed kernel at its link address,
so every imp has the same kernel layout and a guest kernel exploit needs no address leak. Imps
restored from one boot template also share its slab freelist seeds
([boot templates](./lifecycle/boot-templates.md#accepted-risks)).

## The jailer

By default each Firecracker runs under its jailer: in a chroot of its own, as the imp's own uid and
gid, with no capabilities and Firecracker's seccomp filters on every thread. Each imp gets a uid of
its own at create, from a range kept for imps, and keeps it. A guest that escapes into its VMM then
holds only that uid's rights in that chroot.

Before each boot or wake, impd prepares the jail as if the last VM had been hostile:

1. It kills every process of the imp's uid, through the cgroup and then one by one through pidfds,
   so a pid that exits and is reused between the scan and the kill is never hit. A process that
   survives stops the start, and the uid stays taken.
2. It unmounts what an earlier run left, refuses to go on while anything stays mounted, and makes
   the jail again from nothing, since the last VM owned it and may have left symlinks in it.
3. It binds the imp's files in, without setuid or device nodes anywhere below, and the kernel and
   the system drive read-only, with mount events between the jail and the imp's real directory cut
   off both ways. Every directory stays root's, so the VM can write into its own files but never
   swap one for a symlink.

The VM owns its run directory while Firecracker binds its sockets and loads its snapshot. impd then
seals the directory, giving it back to root, before the guest runs a single instruction, and checks
what is in it. Anything there beyond the expected sockets and impd's own files proves a compromised
VM, so the start or the wake fails and impd kills the VM, deleting nothing while it runs. A snapshot
is written into empty files impd makes for it, and handed back to root only once the VM and every
process of its uid are gone. impd opens every file of its own beside a VM without following
symlinks, and checks that each socket is a socket before it connects.

A jailed VM starts only inside its own cgroup, because killing the cgroup is what stops every
process of it at once, faster than a fork chain can outrun a scan. On a host with no cgroup
delegation, the owner turns the jailer off: VMs then run as root, unjailed and without limits. impd
adopts, stops and cleans up VMs of either kind, and a snapshot from either wakes under the other, so
the setting can change across a restart.

## Cgroups

The container's entrypoint takes a private cgroup v2 namespace and makes a subtree for the imps with
the CPU and memory controllers. impd makes one cgroup per VM and starts Firecracker inside it, so no
VM thread ever runs outside its limits. It sets the CPU limit and weight the owner chose, and a hard
memory limit of the guest's memory plus room for Firecracker and the page cache of its disk and
snapshot I/O, with no swap, and an OOM kill that takes the whole VM. The lifecycle then names a VM
that the limit killed as such, rather than as a crash. The soft memory limit stays off, because its
throttling slowed a guest's disk I/O badly. In a container without its own cgroup namespace, impd
stores CPU settings without enforcing them, and no jailed VM starts.

## The host container

impd, Firecracker and tailscaled run in one container, started without `--privileged`, with only the
capabilities, devices and sysctls they use, and a network namespace of its own. That stops
accidents, not an escape: root in the container can still become root on the host, through the mount
capability the jailer's own mounts need. Treat code that gets root in the container as root on the
host ([the host](./host.md#privileges)). The Docker socket is one path out that impd does close,
behind a proxy that lets through only its own calls ([the host](./host.md#the-docker-socket)).

## Between imps

No two imps share a layer-2 network, and a guest cannot send with another imp's address, so an imp
reaches another only through a private network the owner made
([egress](./network/egress.md#networks)). KSM, when the owner turns it on, is a side channel across
every imp on the host ([the RAM governor](./lifecycle/ram-governor.md#ksm)). One owner per host is
the model: the jailer and the VM hold a hostile guest in, but none of it makes a host safe for
several owners.
