# The host

imp runs almost entirely inside the imp-host container: impd, Firecracker, tailscaled and the
firewall for the imps' taps. The host under it is thin, and this doc is the contract it must meet,
so that any installer can meet it. Two installers exist: `deploy/bootstrap.sh` for Ubuntu and
Debian, and the NixOS module in imp's flake ([install](../guides/install.md),
[NixOS](../guides/nixos.md)). [Isolation](./isolation.md) covers what the container's boundary
holds.

## What the host gives

- **KVM** on x86_64, and cgroup v2.
- **Docker**, or a compatible engine, which runs the two containers.
- **Storage**: an XFS mount with reflink on the data directory, or a ZFS dataset impd's backend
  owns, with the modules each needs. The container's ZFS tools must share a major version with the
  host's module ([storage](./storage/storage.md#zfs)).
- **Memory settings**: overcommit on and little swapping, and on ZFS a capped ARC. The ARC sits
  outside impd's RAM budget, so the installers set the budget from the host's RAM less a share for
  the host and the ARC cap.
- **A firewall** that leaves Docker's rules alone and never flushes the whole ruleset, since that
  removes the NAT the container's traffic leaves through.
- **An uplink** for the container's tailscaled, and nothing inbound.

Each installer writes the environment file, installs the seccomp profile from the image, and
installs the two units. The units run the image with the arguments in one file,
`deploy/imp-host.args.json`, from which the systemd unit and the bootstrap script are generated and
which the NixOS module reads, and a test fails when they drift apart. At each start, the unit probes
the host's global addresses for the egress deny list ([egress](./network/egress.md#public)) and the
devices and sysctls the host has. The tailnet node comes back from its saved state in the data
directory when it can, and joins with a key only when it has none.

## Privileges

The container runs without `--privileged`. Its arguments drop every capability and add back the few
impd uses: the mounts for storage, cgroups and the jailer; the network for taps, routes and the
firewall; device nodes for the jail; the uid switches for the jailer; and the file ownership and
capability writes that unpacking an image needs. Each one was kept because a run without it failed,
and the end-to-end harness fails when a dev instance's list differs. `/proc/sys` is read-only, so
the forwarding and tap sysctls come from the container's arguments and the scripts only check them.
AppArmor is unconfined, because Docker's default profile denies `mount`. The seccomp profile is
Docker's default with one rule added, `pivot_root`, which the jailer needs.

**CAUTION:** the container is not a security boundary. With the mount capability in the host's user
namespace, root in the container can mount a new procfs and write `core_pattern`, and the host's
kernel runs that program as root. Treat code that gets root in the container as root on the host.
Dropping `--privileged` stops accidents: the container sees only its devices, loads no modules, and
cannot write the host's sysctls or cgroups by mistake. A real boundary needs the container to run
without the mount capability, which the jailer's mounts need.

The capability to write file capabilities, which images with `ping` or a privileged server need,
lets root in the container stamp any capability on a file it can write. The host keeps such files
inert, because the installers mount the data directory `nosuid`, which ignores setuid bits and file
capabilities alike, and an image is unpacked in a directory no host user can reach.

## The Docker socket

impd pulls, exports and builds images through Docker, but imp-host never mounts the host's socket. A
second container from the same image, imp-docker-proxy, holds it, and serves a socket of its own
that imp-host mounts read-only. The proxy lets through exactly the calls impd and its CLI make, and
refuses every other with a log line:

- a ping and a version check, and an image inspect;
- a pull by name and tag, never from a registry on the host's loopback or by IP address, and never
  of the image the two containers run, so a pull cannot move their tag;
- a BuildKit build with no session, one fixed tag, and the pinned frontend, so a Dockerfile cannot
  choose the image BuildKit runs as its frontend; every parameter that needs a session or moves the
  build, such as a network mode or a remote, is refused;
- a container create of an image with nothing to run and no network, labelled with the proxy's own
  token, and an export and a removal of a container only by that label. There is no start route, so
  a container the proxy creates never runs.

The proxy rebuilds each request from what it checked, rather than pass the client's on, so a form
body or a header cannot smuggle a parameter past the checks. It runs as an unprivileged user with no
capabilities, a read-only root and no network, and its token lives where only it can read it. By
default every build and pull runs in a builder imp instead
([images](./storage/images.md#where-builds-run)), and the proxy then refuses every pull but the
builder's own image and every build on the host. The proxy closes the Docker socket path only: the
mount capability above is still a way out.

imp-host wants the proxy but does not bind to it, so a proxy that stops fails image work only, and
running imps keep running.

## The host firewall

The host needs no inbound port for imp. impd's ports are published on the host's loopback only, the
tailnet reaches impd inside the container, and impd's own tables live in the container's namespace,
where the host's firewall never sees them. The owner chooses who owns the host's inbound firewall:
imp's own table, an input chain that drops all but SSH, ICMP and DHCP, or the platform's firewall,
such as NixOS's. In nftables a drop in any base chain wins, so imp's table blocks whatever another
firewall allows, and the NixOS module refuses it beside the platform's. A firewall that filters
forwarding must admit the container's bridge, or the imps' traffic never leaves.
