# Daemon

impd is one Bun process in the host container. It serves the control API, runs the wake proxy,
starts and stops Firecracker, and keeps the RAM of awake imps under the budget. The code is in
`packages/daemon/src`, one directory per module. This page says what each module does; the
[overview](./overview.md) gives the wider shape.

## Start and stop

On start, impd reads its [configuration](../guides/configuration.md), copies the guest kernel and
the system drive into `system/`, opens the database and runs the migrations, loads or makes the API
token, and re-adopts any Firecracker processes that are still alive. Then it serves the API, opens
the proxy listeners and starts three timers: the idle loop every 2 s, the governor every 5 s, and a
proxy listener sync every 30 s. It adds a default image in the background; `/health` reports
`ready: true` once that finishes, whether it worked or not.

Signals decide what happens to the VMs:

| Signal              | What impd does                                                        |
| ------------------- | --------------------------------------------------------------------- |
| `SIGTERM`, `SIGINT` | Sleeps every awake imp, then exits. A container restart keeps memory. |
| `SIGHUP`            | Exits at once. The VMs keep running; the next impd re-adopts them.    |

[Operations](../guides/operations.md) covers both from the operator's side.

## Modules

### API and auth

The root of the source holds the HTTP app. It serves `/health` without auth, the oRPC router at
`/rpc`, and the exec WebSocket at `/exec`. Both need the bearer token in an `Authorization` header
or a `token` query parameter. The router maps each procedure of the contract in `packages/api` to a
service call. Errors come from the contract: `NOT_FOUND`, `CONFLICT`, `INVALID_STATE` and
`RAM_BUDGET_EXCEEDED`. The token is made on first start and kept in `<dataDir>/token`, readable by
the owner only.

### imps: the lifecycle

<!-- #5 (split of imp-service.ts) rewrites this section with the new module structure. -->

The imp service owns the lifecycle of every imp: create, start, stop, sleep, wake, hold and destroy.
An imp is in one of five states: `creating`, `running`, `sleeping`, `stopped` or `error`. A
transition table says which moves are legal; any other move fails with `INVALID_STATE`. Destroy
works from every state.

- **Locks.** Every lifecycle change for one imp runs under that imp's lock, so two calls never
  change one imp at once.
- **Anything that needs a VM** wakes a sleeping imp and cold-boots a stopped one.
- **Sleeps** run 2 at a time across the host (one semaphore), because each snapshot pushes the whole
  memory file through the page cache.
- **Activity.** A tracker counts the host-side connections that keep an imp awake: exec sessions,
  and proxied requests and WebSockets.
- **Recovery.** After a start, impd re-adopts every live VM by its pid and API socket. A running imp
  with no live VM is marked `stopped`; an imp that was still `creating` goes to `error`. Sleeping
  imps stay asleep.

[Sleep and wake](./sleep-and-wake.md) describes the sleep and wake steps.

### governor: the RAM budget

The governor keeps the RAM of awake imps under `IMP_RAM_BUDGET_MIB`. Before a boot or a wake, the
lifecycle asks it for room. It reserves RAM, sleeps the least recently active imps when the sum
would pass the budget, and fails with `RAM_BUDGET_EXCEEDED` when nothing can make room. An imp with
a hold, a taken lock, an open exec session or a proxied request is never picked. Every 5 s it also
sleeps imps while the measured use is over the budget.
[Sleep and wake](./sleep-and-wake.md#the-ram-governor) has the rules and the numbers.

### idle: the idle loop

Every 2 s the idle loop asks each running imp's agent for its `activity` and reads Firecracker's CPU
time from `/proc`. It combines that with the host-side counts and any hold. An imp with nothing to
keep it awake for `IMP_IDLE_TIMEOUT_S` goes to sleep.

### vmm: Firecracker

The vmm module starts Firecracker detached (`setsid`), so it outlives an impd restart, and talks to
its API over the unix socket. It builds the kernel command line, configures the drives, vsock,
network and balloon, and starts the VM. It also runs the sleep (pause, snapshot, kill) and the wake
(load the snapshot as the first call). It reads `/proc/<pid>/smaps_rollup` for the RAM each VM owns,
and checks a pid's command line, so a recycled pid never counts as a live VM.

### sleep: snapshot metadata

The sleep module writes and reads `snapshot/meta.json`. It records what a memory snapshot is tied
to: the Firecracker version, the snapshot format, the host kernel, and hashes of the guest kernel
and the system drive. A wake compares them with the current values and boots cold on any difference.

### agent-client: the vsock client

The agent client is the host side of the [agent protocol](./protocol.md). It runs the `CONNECT`
handshake on Firecracker's vsock socket, encodes and decodes frames, sends unary requests, and opens
exec streams. It retries pings until the agent answers, so callers can wait for a boot or a wake.

### exec: the exec bridge

Each `/exec` WebSocket becomes one exec session. The session opens an agent exec stream, forwards
stdin, resizes and signals to the guest, and sends output and the exit back. When too many bytes
wait for the client, output stops; the agent connection then stops reading, so a slow client slows
the guest process instead of growing impd's memory.

### proxy: the wake proxy

The proxy serves HTTP and WebSockets for every imp: by Host header on `IMP_PROXY_PORT`, and on one
port per imp at `IMP_PORT_BASE + slot`. A request wakes or boots the imp, then goes to the imp's
HTTP port. WebSockets are relayed message by message. [Networking](./networking.md#the-wake-proxy)
has the details.

### checkpoints: checkpoint, restore, fork

The checkpoint service clones disks. A checkpoint freezes the guest filesystem through the agent,
takes a reflink clone of the disk, and thaws. A sleeping imp wakes first, because its memory holds
page cache that is not on the disk yet. A restore halts the imp, clones the checkpoint over its
disk, drops any memory snapshot, and boots again if the imp was awake. A fork clones a disk or a
checkpoint into a new imp. [Storage](./storage.md#checkpoints-restores-and-forks) covers the files.

### images: OCI images to ext4

The image service turns an OCI image into a sparse ext4 rootfs, once per image ID. It runs
`docker build` for `imp image build`. For `imp image add` it uses the image the host Docker has, and
pulls it when it is missing. Then it exports the filesystem and writes the image config for the
agent. When no image exists, it adds `ubuntu:24.04` as `ubuntu`.
[Storage](./storage.md#images-any-oci-image) covers the pipeline.

### storage: the data layout

The storage module knows where every file under `/var/lib/imp` lives, makes reflink clones (it fails
instead of a full copy), and copies the kernel and system drive into place on start. A changed file
is written next to the old one and renamed over it, so a VM that has the old file open keeps it.

### net: taps and the tailnet

The net module turns a slot into addresses (the /30, the tap name, the MAC and the tailnet port),
creates and removes tap devices, and reads `tailscale status` for the node's name and IP.
[Networking](./networking.md) covers the addressing.

### db: SQLite

The db module opens SQLite through Kysely on `bun:sqlite` and runs the migrations in code. It has
three tables: `images`, `imps` and `checkpoints`. SQLite has one connection, so a promise-chain
mutex gives it to one caller at a time. Timestamps are integer milliseconds since the epoch.

### process: helpers

Small helpers: run a command and capture its output, and a ticker that runs a task on an interval,
never two at once, and logs a failure without stopping.
