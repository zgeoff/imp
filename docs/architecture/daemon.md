# Daemon

impd is one Bun process in the host container. It serves the control API, runs the wake proxy,
starts and stops Firecracker, and keeps the RAM of awake imps under the budget. The code is in
`packages/daemon/src`, one directory per module. This page says what each module does; the
[overview](./overview.md) gives the wider shape.

## Start and stop

On start, impd reads its [configuration](../guides/configuration.md), copies the guest kernel and
the system drive into `system/`, opens the database and runs the migrations, loads or makes the API
token, and re-adopts any Firecracker processes that are still alive. It then deletes the system
drives that no snapshot and no live VM uses ([storage](./storage.md#system-files)). Then it serves
the API, opens the proxy listeners and starts three timers: the idle loop every 2 s, the governor
every 5 s, and a proxy listener sync every 30 s. It adds a default image in the background;
`/health` reports `ready: true` once that finishes, whether it worked or not.

Signals decide what happens to the VMs:

| Signal              | What impd does                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `SIGTERM`, `SIGINT` | Sleeps every awake imp, then exits. A container restart keeps memory.                                |
| `SIGHUP`            | Waits for wakes and boots under way, then exits. The VMs keep running; the next impd re-adopts them. |

The whole stop has a 100 s deadline. [Sleep and wake](./sleep-and-wake.md#restarts) has the steps,
and [operations](../guides/operations.md) covers both signals from the operator's side.

## Modules

### API and auth

The root of the source holds the HTTP app. It serves `/health` without auth, the oRPC router at
`/rpc`, and the exec WebSocket at `/exec`. Both take the bearer token in an `Authorization` header.
A browser cannot set that header on a WebSocket, so `/exec` also takes a `ticket` query parameter:
`exec.ticket` gives a single-use ticket for one existing imp, valid for 30 s. The token itself is
never accepted in a URL, where logs and browser history would keep it; no client used the old
`token` query parameter. impd keeps at most 256 live tickets and drops the oldest past that. The
router maps each procedure of the contract in `packages/api` to a service call. Errors come from the
contract: `NOT_FOUND`, `CONFLICT`, `INVALID_STATE`, `RAM_BUDGET_EXCEEDED`, `SERVICE_UNAVAILABLE`
while impd stops, and `FORBIDDEN` for an exec ticket used for another imp. The token is made on
first start and kept in `<dataDir>/token`, readable by the owner only. `/rpc` takes POST only: a GET
is what a link or an image on any page can make a browser send.

### Dashboard

impd serves the [web dashboard](../guides/dashboard.md) at `/ui/` from `IMP_DASHBOARD_DIR`, and `/`
redirects there. The prefix keeps every dashboard route clear of `/rpc`, `/exec` and `/health`.
Hashed files under `/ui/assets/` are cached for good; the page shell is checked on every load and
carries a CSP that allows only impd and forbids framing.

The browser never holds the API token. `POST /auth/login` takes the token once and sets the
`imp_session` cookie: HttpOnly, SameSite=Strict, `Secure` behind TLS, 30 days. Its value is
`v1.<expiry>.<HMAC-SHA256 of "imp-session-v1.<expiry>">`, keyed by a key derived from the token
(HMAC-SHA256 of `imp-session-key` under the token). It survives an impd restart, and a new token
ends every session. The cookie is host-only, with no `Domain`, so it never reaches another host
name. `POST /auth/logout` only clears the cookie in that browser; a copied value stays valid until
it expires or the token changes.

`/rpc` takes the cookie only from the dashboard's own origin. Imps serve pages on other ports of the
same host, and a browser counts those as the same site, so SameSite alone would let an imp's page
call the API with the owner's session. impd accepts the cookie when `Sec-Fetch-Site` is
`same-origin`; without that header, when `Origin` names impd's host and port. No `Origin` means no
access. The scheme is not compared, so a TLS front such as `tailscale serve` works. Login and logout
take the same check. `/exec` never takes the cookie: the dashboard gets an exec ticket over `/rpc`.

Browsers send cookies to every port of a host, so the wake proxy removes `imp_session` from every
request it forwards to an imp. An imp's server can still set cookies for the host. A planted
`imp_session` on a longer path, which the browser sends first, does not lock the owner out: impd
accepts the request when any `imp_session` value in it is valid. An imp's response can overwrite the
real cookie or flood the cookie jar, and so log the dashboard out while it keeps doing that. It
cannot read or use the session.

### imps: the lifecycle

The imp service owns the lifecycle of every imp: create, start, stop, sleep, wake, hold and destroy.
An imp is in one of five states: `creating`, `running`, `sleeping`, `stopped` or `error`. A
transition table says which moves are legal; any other move fails with `INVALID_STATE`. Destroy
works from every state.

The code splits along the per-imp lock. Every lifecycle change for one imp runs under that imp's
lock, so two calls never change one imp at once.

| File                  | What it does                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imp-service.ts`      | The facade. It wires the parts and hands each consumer a narrow type: the router, the checkpoint service, and the proxy, idle loop and governor.      |
| `imp-lock.ts`         | The per-imp lock. Under it, a caller gets a `LockedImp`: a fresh record that only this module can make. A new imp's record is written under its lock. |
| `imp-vm-ops.ts`       | Boot, halt, sleep and wake a VM. Each takes a `LockedImp`, so none can run without the lock. Sleeps run 2 at a time across the host.                  |
| `imp-commands.ts`     | The API commands, each under the imp's lock.                                                                                                          |
| `imp-runtime.ts`      | Exec, wake on demand for the proxy, background sleeps, the sleep pass on SIGTERM, and reconcile after a start.                                        |
| `lock-free-sleep.ts`  | The background sleep the idle loop and the governor use. It only tries the lock and never waits for it.                                               |
| `shutdown-gate.ts`    | Closed once the SIGTERM sleep pass starts. After that no VM boots or wakes.                                                                           |
| `imp-liveness.ts`     | Marks an imp with a dead VM or a lost snapshot `stopped`, or `sleeping` when its VM died after the sleep wrote the snapshot.                          |
| `imp-presenter.ts`    | Imp records as the API shows them, and their URLs.                                                                                                    |
| `activity-tracker.ts` | Counts the host-side connections that keep an imp awake: exec sessions, and proxied requests and WebSockets.                                          |

- **Anything that needs a VM** wakes a sleeping imp and cold-boots a stopped one. An exec counts its
  session before the wake, so no background sleep slips in between.
- **Recovery.** After a start, impd re-adopts every live VM by its pid and API socket. A running imp
  with no live VM is marked `stopped` (or `sleeping`, see above); an imp that was still `creating`
  goes to `error`, and its VM is killed. If the VM does not die, the record keeps its pid for a
  later start or destroy, and impd starts anyway. Sleeping imps stay asleep.

[Sleep and wake](./sleep-and-wake.md) describes the sleep and wake steps.

### governor: the RAM budget

The governor keeps the RAM of awake imps under `IMP_RAM_BUDGET_MIB`. Before a boot or a wake, the
lifecycle asks it for room. It reserves RAM, sleeps the least recently active imps when the sum
would pass the budget, and fails with `RAM_BUDGET_EXCEEDED` when nothing can make room. An imp with
a hold, a taken lock, an open exec session or a proxied request is never picked. It never waits for
an imp's lock: a victim locked by the time its turn comes is skipped. Every 5 s it also sleeps imps
while the measured use is over the budget, all it may sleep when they cannot bring it under.
[Sleep and wake](./sleep-and-wake.md#the-ram-governor) has the rules and the numbers.

### idle: the idle loop

Every 2 s the idle loop asks each running imp's agent for its `activity` and reads Firecracker's CPU
time from `/proc`. It combines that with the host-side counts and any hold. An imp with nothing to
keep it awake for `IMP_IDLE_TIMEOUT_S` goes to sleep, unless it was held or active again by the time
the sleep takes its lock.

### vmm: Firecracker

The vmm module starts Firecracker detached (`setsid`), so it outlives an impd restart, and talks to
its API over the unix socket. It builds the kernel command line, configures the drives, vsock,
network and balloon, and starts the VM. It also runs the sleep (pause, snapshot, kill) and the wake
(load the snapshot as the first call). It reads `/proc/<pid>/smaps_rollup` for the RAM each VM owns,
and checks a pid's command line, so a recycled pid never counts as a live VM. Every API call times
out: 10 s, or 120 s for a snapshot create or load.

### sleep: snapshot metadata

The sleep module writes and reads `vm.json`, what a VM booted with, and `snapshot/meta.json`, which
copies it at each sleep: the Firecracker version, the snapshot format, the host kernel, the sha256
of the guest kernel and of the system drive, the drive's path and the agent's protocol version. A
wake checks the snapshot against this host and boots cold when it cannot load
([snapshot identity](./sleep-and-wake.md#snapshot-identity)).

### agent-client: the vsock client

The agent client is the host side of the [agent protocol](./protocol.md). It runs the `CONNECT`
handshake on Firecracker's vsock socket, encodes and decodes frames, sends unary requests, and opens
exec streams. It retries pings until the agent answers, so callers can wait for a boot or a wake. An
exec that the agent does not start within 10 s fails and closes its connection.

### exec: the exec bridge

Each `/exec` WebSocket becomes one exec session. The session opens an agent exec stream, forwards
stdin, resizes and signals to the guest, and sends output and the exit back. When too many bytes
wait for the client, output stops; the agent connection then stops reading, so a slow client slows
the guest process instead of growing impd's memory.

### proxy: the wake proxy

The proxy serves HTTP and WebSockets for every imp: by Host header on `IMP_PROXY_PORT`, and on one
port per imp at `IMP_PORT_BASE + slot`. A request wakes or boots the imp, then goes to the imp's
HTTP port, without the dashboard's session cookie. WebSockets are relayed message by message.
[Networking](./networking.md#the-wake-proxy) has the details.

### checkpoints: checkpoint, restore, fork

The checkpoint service clones disks. A checkpoint freezes the guest filesystem through the agent,
takes a reflink clone of the disk, and thaws. A sleeping imp wakes first, because its memory holds
page cache that is not on the disk yet. A restore halts the imp, clones the checkpoint over its
disk, drops any memory snapshot, and boots again if the imp was awake. It clones before it halts, so
a failed clone leaves the imp running or asleep as it was. A fork clones a disk or a checkpoint into
a new imp. [Storage](./storage.md#checkpoints-restores-and-forks) covers the files.

### images: OCI images to ext4

The image service turns an OCI image into a sparse ext4 rootfs, once per image ID. It runs
`docker build` for `imp image build`. For `imp image add` it uses the image the host Docker has, and
pulls it when it is missing. Then it exports the filesystem and writes the image config for the
agent. When no image exists, it adds `ubuntu:24.04` as `ubuntu`.
[Storage](./storage.md#images-any-oci-image) covers the pipeline.

### storage: the data layout

The storage module knows where every file under `/var/lib/imp` lives, makes reflink clones (it fails
instead of a full copy), and copies the kernel and system drive into place on start
([system files](./storage.md#system-files)).

### net: taps and the tailnet

The net module turns a slot into addresses (the /30, the tap name, the MAC and the tailnet port),
creates and removes tap devices, and reads `tailscale status` for the node's name and IP.
[Networking](./networking.md) covers the addressing.

### db: SQLite

The db module opens SQLite through Kysely on `bun:sqlite` and runs the migrations in code. It has
three tables: `images`, `imps` and `checkpoints`. SQLite has one connection, so a promise-chain
mutex gives it to one caller at a time. Timestamps are integer milliseconds since the epoch.

### process: helpers

Small helpers: run a command and capture its output, a ticker that runs a task on an interval, never
two at once, and logs a failure without stopping, and a bounded wait for impd's stop steps.
