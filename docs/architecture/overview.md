# Architecture overview

imp is a self-hosted take on Fly.io Sprites: persistent Linux microVMs that boot in about a second,
sleep when idle with their memory intact, wake on an HTTP request, and checkpoint, restore and fork
their disks instantly. One host runs everything. The control plane, impd, lives in one container
next to the Firecracker processes it starts. Inside each guest, a small Go agent runs as PID 1 and
talks to impd over vsock.

This page gives the shape and the main decisions. The other architecture pages go deeper:

- [Daemon](./daemon.md): the modules inside impd.
- [Guest agent and kernel](./agent.md): how a guest boots, and the custom kernel.
- [Agent protocol](./protocol.md): the host ↔ guest wire format.
- [Storage and images](./storage.md): XFS reflinks or ZFS, the data layout, OCI images to ext4.
- [Networking](./networking.md): taps, /30s, iptables, the wake proxy and the URLs.
- [Sleep and wake](./sleep-and-wake.md): memory snapshots, idle detection and the RAM governor.
- [Backups](./backups.md): restic backups of disks, checkpoints and images, off the host.
- [Boot templates](./boot-templates.md): a cold boot restored from a snapshot of a parked guest.

## Shape

```text
 CLI (bun)  ──oRPC/HTTP──┐
 browser/curl ──HTTP─────┤
 ssh/scp/sftp ──SSH──────┤
                         ▼
 ┌──────────── imp host container (root, own netns) ──────────────────┐
 │  impd (bun)                                                        │
 │   ├─ rpc        oRPC router (control) + WebSocket (exec streams)   │
 │   ├─ proxy      wake-on-request HTTP/WebSocket proxy               │
 │   ├─ broker     credential connectors: CONNECT proxy on gateways   │
 │   ├─ ssh        SSH gateway: shells, SFTP, forwards into imps      │
 │   ├─ imps       lifecycle service, one state machine per imp       │
 │   ├─ governor   RAM budget; idle loop sleeps quiet imps            │
 │   ├─ vmm        Firecracker API client (HTTP over unix socket)     │
 │   ├─ agent      host side of the vsock agent protocol              │
 │   ├─ images     OCI image → ext4 builder                           │
 │   ├─ storage    XFS reflink clones or ZFS clones, the data layout  │
 │   ├─ net        tap devices, routes, iptables                      │
 │   └─ db         Kysely + bun:sqlite                                │
 │                                                                    │
 │  firecracker ×N (detached; survive an impd restart)                │
 │  tailscaled (optional)                                             │
 └────────────────────────────────────────────────────────────────────┘
                         │ virtio-blk / virtio-net / vsock
                         ▼
 ┌──────────────── guest (one per imp) ────────────────┐
 │ /dev/vda  user rootfs (ext4, rw) from any OCI image  │
 │ /dev/vdb  imp system drive (ro): imp-agent           │
 │ PID 1 = imp-agent: mounts, network, service          │
 │   supervisor, zombie reaper, exec/PTY over vsock     │
 └──────────────────────────────────────────────────────┘
```

## Isolation: Firecracker microVMs

- One Firecracker microVM per imp gives a hardware (KVM) boundary per tenant.
- Firecracker over QEMU: about 5 MB of VMM overhead against 50–150 MB, fast snapshot and restore,
  and a minimal device model. The cost: no GPU and no virtiofs.
- Each Firecracker runs under its jailer, as the imp's own uid in a chroot
  ([#27](https://github.com/zgeoff/imp/issues/27)). The host container around them is not a security
  boundary ([privileges](./host-contract.md#privileges)).
- The guest has no inner container yet. Fly runs user code in a container inside the VM, so the
  agent survives a user who breaks PID 1 or runs `rm -rf /`. imp runs user code next to the agent.
  That risk is accepted for a personal platform ([#28](https://github.com/zgeoff/imp/issues/28)).
- KASLR is off in every guest: Firecracker loads the uncompressed `vmlinux` at its link address, and
  the guest logs `KASLR disabled`, although the config has `RANDOMIZE_BASE=y`. Every imp has the
  same kernel layout, so a kernel exploit needs no address leak. Imps restored from one
  [boot template](./boot-templates.md#accepted-risks) also share the slab freelist seeds.

## Host: one container

- impd, Firecracker and tailscaled run in one container, started without `--privileged`: it gets
  only the capabilities, devices and sysctls it uses ([privileges](./host-contract.md#privileges)),
  and its **own** network namespace. That stops accidents, not an escape: root in it can still
  become root on the host. Taps, routes and iptables never touch the host's network. The same image
  runs on bare metal.
- impd builds and exports OCI images through `imp-docker-proxy`, a second container that holds the
  host's Docker socket and lets through only the calls impd makes
  ([the Docker socket](./host-contract.md#the-docker-socket)). That closes the Docker socket path
  only: `SYS_ADMIN` still lets root out of the container.
- Data lives in `/var/lib/imp`, backed by a host bind mount
  ([storage](./storage.md#the-data-directory)).
- The container entrypoint (`host/entrypoint`) sets up storage, the network and Tailscale, then runs
  impd under a small supervisor that restarts it when it exits on its own.

## Control plane and API

- Bun workspaces: `packages/api` (the oRPC contract and zod schemas), `packages/daemon` (impd),
  `packages/cli` (the `imp` CLI) and `packages/client` (`@zgeoff/imp-client`, the typed client on
  npm for browsers, Bun and Node).
- Control calls are oRPC procedures over HTTP at `/rpc`. Exec and console use a WebSocket at
  `/exec`, because they need two-way streams. The dashboard is at `/ui/` and the MCP endpoint at
  `/mcp`. `/health` answers without auth.
- Auth: impd makes a bearer token on first start and stores it in `/var/lib/imp/token`. A browser
  opens `/exec` with a single-use ticket from `exec.ticket` instead of the token. Scoped tokens and
  tailnet identities give less than full access ([tokens](../guides/tokens.md)). The proxy is open
  to anything that can reach it; the tailnet ACL is the boundary.
- State is in SQLite through Kysely on `bun:sqlite`. Migrations live in code.

## Repo layout

```text
agent/            Go guest agent (PID 1, vsock server)
packages/api      oRPC contract and shared types
packages/daemon   impd
packages/cli      imp CLI
packages/client   @zgeoff/imp-client, the typed client published to npm
packages/dashboard web dashboard, served at /ui/
packages/mcp      MCP server, behind imp mcp and /mcp
images/base       thin base image
images/dev        example dev image
host/             host container Dockerfile (dev and release), entrypoint, storage, network
                  and tailnet setup
deploy/           compose file, systemd unit and env file for the release image, the server
                  bootstrap and the upgrade script
kernel/           guest kernel config and build
scripts/          dev helpers and test-e2e.sh, the end-to-end harness's entry point
test/e2e/         end-to-end suites, their helpers and fixture images
docs/             this documentation
```

## Not yet

The [roadmap](https://github.com/zgeoff/imp/issues/41) tracks what is left: the jailer, an inner
container, memory forks, more than one host and more.
