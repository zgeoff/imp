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
the API, opens the proxy listeners and the credential broker and the
[SSH gateway](#ssh-the-gateway), and starts four timers: the idle loop every 2 s, the governor every
5 s, a proxy listener sync every 30 s, and a broker sync every 60 s. It adds a default image in the
background; `/health` reports `ready: true` once that finishes, whether it worked or not.

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
`/rpc`, the exec WebSocket at `/exec`, and the tunnel WebSocket at `/tunnel`. Each takes the bearer
token in an `Authorization` header. A browser cannot set that header on a WebSocket, so `/exec` also
takes a `ticket` query parameter: `exec.ticket` gives a single-use ticket for one existing imp,
valid for 30 s; `/tunnel` takes no ticket, since only the CLI opens it. The token itself is never
accepted in a URL, where logs and browser history would keep it; no client used the old `token`
query parameter. impd keeps at most 256 live tickets and drops the oldest past that. The router maps
each procedure of the contract in `packages/api` to a service call. Errors come from the contract:
`NOT_FOUND`, `CONFLICT`, `INVALID_STATE`, `RAM_BUDGET_EXCEEDED`, `SERVICE_UNAVAILABLE` while impd
stops, `FORBIDDEN` for an exec ticket used for another imp, and `AGENT_OUTDATED` for a session
request to an agent from before sessions. The token is made on first start and kept in
`<dataDir>/token`, readable by the owner only. `/rpc` takes POST only: a GET is what a link or an
image on any page can make a browser send.

### Dashboard

impd serves the [web dashboard](../guides/dashboard.md) at `/ui/` from `IMP_DASHBOARD_DIR`, and `/`
redirects there. The prefix keeps every dashboard route clear of `/rpc`, `/exec` and `/health`.
Hashed files under `/ui/assets/` are cached for good; the page shell is checked on every load and
carries a CSP that allows only impd and forbids framing.

The browser never holds the API token. `POST /auth/login` takes the token once and sets the session
cookie: HttpOnly, SameSite=Strict, 30 days. Over plain HTTP it is `imp_session`. Behind TLS (an
https URL, or `x-forwarded-proto: https`) it is `__Host-imp_session`, which is `Secure`, and the
browser takes it only host-only and on `/`, so no other name under an
[HTTPS domain](../guides/https.md), an imp's included, can set it. Its value is
`v1.<expiry>.<HMAC-SHA256 of "imp-session-v1.<expiry>">`, keyed by a key derived from the token
(HMAC-SHA256 of `imp-session-key` under the token). It survives an impd restart, and a new token
ends every session. The cookie is host-only, with no `Domain`, so it never reaches another host
name. `POST /auth/logout` clears the cookie in that browser, both names behind TLS; a copied value
stays valid until it expires or the token changes.

`/rpc` takes the cookie only from the dashboard's own origin. Imps serve pages on other ports of the
same host, and a browser counts those as the same site, so SameSite alone would let an imp's page
call the API with the owner's session. impd accepts the cookie when `Sec-Fetch-Site` is
`same-origin`; without that header, when `Origin` names impd's host and port. No `Origin` means no
access. The scheme is not compared, so a TLS front such as `tailscale serve` works. Login and logout
take the same check. `/exec` never takes the cookie: the dashboard gets an exec ticket over `/rpc`.

Browsers send cookies to every port of a host, so the wake proxy removes both cookie names from
every request it forwards to an imp. An imp's server can still set cookies for the host. A planted
`imp_session` on a longer path, which the browser sends first, does not lock the owner out: impd
accepts the request when any session value under either name is valid. An imp's response can
overwrite the real cookie or flood the cookie jar, and so log the dashboard out while it keeps doing
that. It cannot read or use the session.

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
| `activity-tracker.ts` | Counts the host-side connections that keep an imp awake: exec sessions, proxied requests and WebSockets, SSH connections, and tunnels.                |

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
a hold, a taken lock, an open exec session, a proxied request, an SSH connection or a tunnel is
never picked. It never waits for an imp's lock: a victim locked by the time its turn comes is
skipped. It sleeps one victim at a time and picks again after each, so a skip or a failed sleep
never leads to more sleeps than the new pick needs. Every 5 s it also sleeps imps while the measured
use is over the budget, all it may sleep when they cannot bring it under.
[Sleep and wake](./sleep-and-wake.md#the-ram-governor) has the rules and the numbers.

### events: the event stream

`db/imps.ts` and `db/checkpoints.ts` emit a write after each commit, with the reason its caller
gives; no other code writes those rows. The publisher turns each write into an event in the API's
shape, one at a time, so events keep the order of the writes, and puts it on the bus. The bus feeds
`events.stream`, the proxy's and the broker's resync when an imp comes or goes, and the telemetry.
The governor puts its decisions on the same bus. A stream subscribes before it reads its snapshot
and ends a reader that falls 1000 events behind. [Events](../guides/events.md) has the format.

The audit module writes one `api_audit` row per mutation, from oRPC middleware, and per exec,
console, attach and SSH open, after the answer. It never stores the input.

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
the guest process instead of growing impd's memory. Bun pings an idle exec socket and closes it
after 30 s without an answer, so a client that vanished without a close lets go of its session.

### tunnel: `imp proxy`

`imp proxy <name> 5432 3001:3000` listens on local ports and opens one `/tunnel` WebSocket per TCP
connection (`packages/api/src/tunnel-protocol.ts`). The client sends
`{"type":"open","name":"box","port":5432}`; impd wakes the imp and dials `127.0.0.1:<port>` in the
guest through the agent's [`dial`](./protocol.md#dial), so a server that listens on the guest's
loopback only is reachable. impd answers `{"type":"opened"}`, or `{"type":"error","code",...}` and a
close: `NOT_FOUND`, `DIAL_FAILED`, `AGENT_OUTDATED` for an agent from before `dial`, and
`TUNNEL_LIMIT` past 256 open tunnels per imp.

- **Bytes.** Binary messages carry the bytes both ways. `{"type":"eof"}` is a TCP half-close from
  that side, so a client that half-closes still gets its reply.
- **Flow control.** Neither end of a WebSocket can pause its reads, so each side acks the bytes it
  delivered onward (`{"type":"ack","bytes":n}`), and a sender keeps at most 1 MiB unacked. impd acks
  once the guest connection took the bytes; the CLI acks once its TCP socket did. The CLI sends at
  most 64 KiB per message, so it passes the window by one message at most; a client that sends a
  larger message, or holds more unacked than that, is closed with 1002, so it cannot grow impd's
  memory.
- **The end.** The close codes are in `tunnel-protocol.ts`. impd closes with 1000 once both sides
  sent their eof, with 4000 when the connection in the guest ended without one (a reset, or a forced
  sleep), with 1002 for a message that breaks the protocol, and with 1012 when impd stops. The CLI
  resets the local connection for anything but 1000. When impd cannot be reached at all, it prints
  one notice for a burst of failed connections, not one per connection.
- **Activity.** An open tunnel counts as a `tunnel` connection from before the wake, so it keeps the
  imp awake, and neither the idle loop nor the governor sleeps the imp under it.

The CLI listens on 127.0.0.1 and ::1 before it calls impd, so a busy port fails at once, then checks
the imp exists with `imps.get`, which does not wake it. Each local socket stays paused until
`opened`.

### sessions: detachable consoles

A session is a program on a pty in the guest that outlives its WebSocket
([protocol](./protocol.md#sessions)). On `/exec`, a `start` with a `session` name starts the
session, or attaches to it if it runs; `attach` attaches to one that exists. The socket gets
`started` (with `session` and `created`), the replay of recent output, then live output. Closing the
socket detaches: the program keeps running.

One client is attached at a time. A new attach takes the session over, and the client attached
before gets `detached` with `taken_over`; a client too far behind gets `slow`. When impd loses the
agent connection without an exit or a detach (the imp went to sleep, a vsock reset), the socket gets
`detached` with `lost` and closes with 1000: the session runs on, and the client may attach again. A
plain exec in that case still fails with 1011, because the agent sent its process SIGHUP. Read-only
viewers, which watch without taking the session over, are future work.

An attached socket counts as an exec connection, so it keeps the imp awake. A detached session holds
no connection: it keeps the imp awake only through its CPU or TCP use
([idle detection](./sleep-and-wake.md#idle-detection)).

The code is in `sessions/`: the list and kill service, the in-memory copy of each awake imp's
sessions, and the count `imp ls` shows. An imp woken with an agent from before sessions keeps it
until its next cold boot; a session request to it fails with `AGENT_OUTDATED`. impd checks the agent
version it recorded at boot before a session exec, so an old agent never runs the command as a plain
exec. An attach or a kill that the old agent answers with `UNKNOWN_OP` fails the same way.

`sessions.list` never wakes an imp. The idle loop reads every awake imp's sessions from `activity`
every 2 s and keeps them in memory; a list of an awake imp asks the agent again, and falls back to
that copy. Just before a sleep pauses the VM, under the imp's lock, impd reads the sessions once
more and writes them to `snapshot/meta.json`, so a sleeping imp lists them from there. A stopped imp
has none. `sessions.kill` wakes the imp. `imp ls` and `imp info` count sessions from the same
copies.

### ssh: the gateway

The SSH gateway is in impd itself, on `ssh2`, so it reaches the lifecycle, the activity tracker and
the agent client directly. A separate SSH server (Go's `x/crypto/ssh`) would need the exec protocol
again and new RPCs for wakes and activity. The cost: `ssh2` has no post-quantum key exchange, and
OpenSSH 10.1 and later warn about that ([SSH guide](../guides/ssh.md#set-up)). impd carries one
patch to `ssh2` (`patches/`): a refused channel open can say why, so a forward to another host is
"administratively prohibited", not "connect failed"; and a server can open an
`auth-agent@openssh.com` channel, for agent forwarding.

- **Connections.** impd accepts each TCP connection and hands it to `ssh2`. A client must log in
  within 30 s; at most 32 connections wait to log in, and a 33rd is dropped. Six refused logins end
  the connection. A keepalive every 15 s drops a client that misses 3.
- **Login.** Public keys only, from `<dataDir>/ssh/authorized_keys`, read again when the file
  changes. The SSH user names the imp. The key check and the imp lookup give the same refusal, and
  nothing before a verified signature for a known imp touches the imp. A login opens an `ssh`
  connection in the activity tracker and starts the wake; channels wait for it. A failed wake
  reaches each channel as an error on stderr and exit status 255, not as a refused login.
- **Sessions.** A shell, a command or the `sftp` subsystem is an agent exec, as `imp exec` is: the
  pty and its size, `TERM`, `LANG` and `LC_*`, and `SSH_CONNECTION` go with it, and resizes and
  signals follow it. SFTP runs `/run/imp/sys/imp-agent sftp` from the system drive. Client input
  pauses until the agent connection has taken the last chunk, so a slow guest holds back the
  client's SSH window instead of growing impd's memory.
- **Forwards.** `direct-tcpip` to the imp's own loopback and `direct-streamlocal` to a socket path
  use the agent's [`dial`](./protocol.md#dial), which connects from inside the guest. The channel
  opens only once the dial worked. Remote forwards and X11 are refused.
- **Agent forwarding.** After an `auth-agent-req@openssh.com`, the connection's sessions get
  `SSH_AUTH_SOCK` from one [`agent.listen`](./protocol.md#agentlisten-and-agentaccept) socket in the
  guest, opened on first use and closed with the connection. Each client of the socket becomes an
  `auth-agent@openssh.com` channel to the user, relayed through `agent.accept`; past 16 open
  channels, or when the user refuses the channel, the client is closed at once. A wake starts a new
  VM, so a session in a VM other than the socket's gets a new socket. Any failure leaves the command
  to run without `SSH_AUTH_SOCK`, with the reason on stderr.
- **Stop.** impd ends every SSH connection before the sleep pass, as it closes exec sessions.

The code is in `ssh/`. The host key is `<dataDir>/ssh/host_key`; `ssh2`'s own ed25519 generator
writes an unreadable key about once in 256, so impd checks each key it makes and makes another.

### proxy: the wake proxy

The proxy serves HTTP and WebSockets for every imp: by Host header on `IMP_PROXY_PORT`, and on one
port per imp at `IMP_PORT_BASE + slot`. A request wakes or boots the imp, then goes to the imp's
HTTP port, without the dashboard's session cookie. WebSockets are relayed message by message.
[Networking](./networking.md#the-wake-proxy) has the details.

### broker: credential connectors

The broker holds secrets for imps and adds them to their requests
([connectors](../guides/connectors.md)). Its front port takes each guest's `CONNECT`, names the imp
from the connection's two ends, and pipes a granted host's connection into a TLS terminator: one Bun
server per (imp, host) on a unix socket in `<data>/broker/run`, with a leaf from the host CA in
`<data>/broker/ca`. The terminator reads the grant and the value for each request, so a revoke takes
effect at once. Any other host is a plain tunnel to a checked public address. Values live in
`<data>/secrets`, one 0600 file each; the database keeps names, hosts and grants, and the audit
rows. Every exec of an imp with a grant gets the proxy and CA variables, once one exec per boot has
written the CA bundle into the guest. A 60 s ticker, and every create and destroy, stops terminators
that no grant covers and renews leaves near their end.

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

The db module opens SQLite through Kysely on `bun:sqlite` and runs the migrations in code. Its
tables are `images`, `imps`, `checkpoints`, the broker's `secrets`, `grants` and `broker_audit`, and
`api_audit`. SQLite has one connection, so a promise-chain mutex gives it to one caller at a time.
Timestamps are integer milliseconds since the epoch.

### process: helpers

Small helpers: run a command and capture its output, a ticker that runs a task on an interval, never
two at once, and logs a failure without stopping, and a bounded wait for impd's stop steps.
