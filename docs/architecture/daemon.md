# Daemon

impd is one Bun process in the host container. It serves the control API, runs the wake proxy,
starts and stops Firecracker, and keeps the RAM of awake imps under the budget. The code is in
`packages/daemon/src`, one directory per module. This page says what each module does; the
[overview](./overview.md) gives the wider shape.

## Start and stop

On start, impd reads its [configuration](../guides/configuration.md), copies the guest kernel and
the system drive into `system/`, opens the database and runs the migrations, loads or makes the API
token, and settles every Firecracker process that is still alive: it adopts the VMs its records own
and kills the rest ([restarts](./sleep-and-wake.md#restarts)). It then deletes the system drives
that no snapshot and no live VM uses ([storage](./storage.md#system-files)). Then it serves the API,
opens the proxy listeners and the credential broker and the [SSH gateway](#ssh-the-gateway), and
starts its timers:

| Timer         | Every                       | What it does                                                                            |
| ------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| idle          | 2 s                         | the [idle loop](#idle-the-idle-loop), which also feeds the watchdog                     |
| governor      | 5 s                         | sleeps imps while the RAM in use is over the budget                                     |
| resources     | 5 s                         | samples each running VM's CPU, network and RAM ([cgroups](#cgroups))                    |
| proxy         | 30 s                        | syncs the proxy listeners with the imps                                                 |
| tailnet-names | 10 min                      | repairs [per-imp tailnet names](../guides/tailscale.md#per-imp-names), when they are on |
| broker        | 60 s                        | stops terminators no grant covers and renews leaves                                     |
| gc            | 1 h                         | the storage sweep ([cleanup](./storage.md#cleanup))                                     |
| disk-usage    | 5 min                       | measures each imp's disk use ([disk usage](./storage.md#disk-usage))                    |
| backup        | the interval, at most 5 min | starts a backup run once one is due, when backups are on                                |

It adds a default image in the background; `/health` reports `ready: true` once that finishes,
whether it worked or not.

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
`/rpc`, the exec WebSocket at `/exec`, the tunnel WebSocket at `/tunnel`, and `POST /images/build`,
which takes a build context as a streamed tar ([images](../guides/images.md#build-an-image)). Each
takes a bearer token in an `Authorization` header, or a tailnet identity. A browser cannot set that
header on a WebSocket, so `/exec` also takes a `ticket` query parameter: `exec.ticket` gives a
single-use ticket for one existing imp, valid for 30 s; `/tunnel` takes no ticket, since only the
CLI opens it. The token itself is never accepted in a URL, where logs and browser history would keep
it. impd keeps at most 32 live tickets per caller, and 1024 in all. The router maps each procedure
of the contract in `packages/api` to a service call. Errors come from the contract: `NOT_FOUND`,
`CONFLICT`, `INVALID_STATE`, `RAM_BUDGET_EXCEEDED`, `DISK_FULL` when a write would cut into the
[disk reserve](./storage.md#disk-budget), `SERVICE_UNAVAILABLE` while impd stops, `FORBIDDEN` for a
call outside the caller's scope or imps, `PRECONDITION_FAILED` when the host is not set up for the
call (backups with no repository, say), `AGENT_OUTDATED` for a request the imp's agent is too old
for, `LEASED` for a sleep or stop without `force` of a leased imp, `LEASE_NOT_HELD` for a renew of a
lease the caller does not hold ([leases](../guides/leases.md)), and `INVALID_RESUME` for a session
resume past the end of its output ([output offsets](#output-offsets)). `LEASED` and
`RAM_BUDGET_EXCEEDED` show only what the caller may see. `/rpc` takes POST only: a GET is what a
link or an image on any page can make a browser send.

`/mcp` serves the MCP tools over HTTP ([guide](../guides/mcp.md#http)). It takes a token or a
tailnet identity, never the cookie, and resolves the caller on every POST. Each tool call goes
through the same `/rpc` handler in process, as that caller, so the router's access map and the audit
log cover it as they cover the CLI. An exec redeems a ticket and joins an `/exec` session in
process, with no socket. The API server's idle timeout is off for `/mcp`, and SSE comments every 5 s
keep a long call open through a proxy.

Every call runs as a caller: the root token in `<dataDir>/token`, a named token with a scope and
optional imp patterns, the dashboard session made with one, an SSH key, or a tailnet member.
`auth/authenticate.ts` finds the caller for every route alike. `auth/access-policy.ts` maps every
procedure to the scope it needs; the router checks it before input validation and before the
handler, and handlers that list filter by the caller's imps.
[Tokens and identities](../guides/tokens.md) covers the scopes, the patterns, and how each way in is
checked.

### Dashboard

impd serves the [web dashboard](../guides/dashboard.md) at `/ui/` from `IMP_DASHBOARD_DIR`, and `/`
redirects there. The prefix keeps every dashboard route clear of `/rpc`, `/exec` and `/health`.
Hashed files under `/ui/assets/` are cached for good; the page shell is checked on every load and
carries a CSP that allows only impd and forbids framing.

The browser never holds an API token. `POST /auth/login` takes a token once, the root token or a
made one, and sets the session cookie: HttpOnly, SameSite=Strict, 30 days. The session acts with
that token's scope. Over plain HTTP it is `imp_session`. Behind TLS (an https URL, or
`x-forwarded-proto: https`) it is `__Host-imp_session`, which is `Secure`, and the browser takes it
only host-only and on `/`, so no other name under an [HTTPS domain](../guides/https.md), an imp's
included, can set it. Its value is
`v2.<token id>.<expiry>.<HMAC-SHA256 of "imp-session-v2.<token id>.<expiry>">`, keyed by a key
derived from the root token (HMAC-SHA256 of `imp-session-key` under it). The root token's id is
`root`. It survives an impd restart. A new root token ends every session; removing a token ends its
own, since impd checks on each request that the token still exists. The cookie is host-only, with no
`Domain`, so it never reaches another host name. `POST /auth/logout` clears the cookie in that
browser, both names behind TLS; a copied value stays valid until it expires or the token changes.

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
- **Orphans** (`reconcile-vms.ts`). impd scans `/proc` for Firecracker processes on an imp's API
  socket. It kills every one the record does not own, adopts the one VM a dead impd left mid-wake,
  resumes a paused VM of a running imp, and deletes half-written snapshot files.

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
console, attach, SSH and tunnel open, after the answer. It never stores the input.

### idle: the idle loop

Every 2 s the idle loop asks each running imp's agent for its `activity` and reads Firecracker's CPU
time from `/proc`. It combines that with the host-side counts and any hold. An imp with nothing to
keep it awake for `IMP_IDLE_TIMEOUT_S` goes to sleep, unless it was held or active again by the time
the sleep takes its lock.

### watchdog: silent agents

The idle loop feeds the watchdog each agent's answer. An agent silent for `IMP_WATCHDOG_TIMEOUT_S`
gets one more 5 s ping, then the watchdog acts by `IMP_WATCHDOG_ACTION`: it reports, restarts the
VM, or writes a snapshot to `<imp>/watchdog/` and restarts. Restarts back off and stop at 3 an hour.
[Sleep and wake](./sleep-and-wake.md#the-watchdog) has the rules.

### vmm: Firecracker

The vmm module starts Firecracker detached (`setsid`), so it outlives an impd restart, and talks to
its API over the unix socket. It builds the kernel command line, configures the drives, vsock,
network and balloon, and starts the VM. It also runs the sleep (pause, snapshot, kill) and the wake
(load the snapshot as the first call). It reads `/proc/<pid>/smaps_rollup` for the RAM each VM owns,
and checks a pid's command line, so a recycled pid never counts as a live VM. Every API call times
out: 10 s, or 120 s for a snapshot create or load.

#### The jailer

With `IMP_JAILER=true`, the default, each VM runs under Firecracker's jailer: in a chroot at
`<data>/jail/firecracker/<id>/root`, as the imp's own uid and gid, with no capabilities, in
Firecracker's default seccomp filters on every thread. Each imp gets its uid at create, the lowest
free one from 900000 up (65536 of them), and keeps it in the `jail_uid` column.

Before each boot or wake, impd prepares the chroot:

1. It kills every process of the imp's uid: `cgroup.kill` on the imp's cgroup, then SIGKILL to each
   process `/proc` lists for the uid, until none is left. Each SIGKILL goes through a pidfd
   (`pidfd_open`, the uid read again, `pidfd_send_signal`), so a pid that exits and goes to another
   process between the scan and the kill is never hit. Without pidfd (glibc before 2.36, or a kernel
   before 5.3) impd reads the uid again just before `kill()`, which narrows that window but does not
   close it. One that a guest escape forked from Firecracker cannot outlive it, race the root work
   in the jail below, or run on as the next imp that gets the uid. A process that survives 1 s of
   this stops the start, and a destroy, so the uid stays taken.
2. It unmounts what an earlier run left, and refuses to go on while anything stays mounted. It then
   deletes the whole jail and makes it again: the last VM owned the chroot and may have left
   symlinks in it.
3. It empties `run/` of everything but the log, gives it to the imp's uid until the seal below, and
   chowns the disk to the uid. The snapshot files the VM loads are root's, readable by the imp's
   group (0640). Every directory stays root's, so the VM can write into its files but never swap one
   for a symlink or a FIFO. A snapshot file that is not a regular file stops the start.
4. It binds the chroot to itself and makes it private, then binds in the imp's directory at its own
   absolute path. On ZFS it binds the snapshot dataset too. Every bind is `nosuid,nodev`, on each
   submount too (`nosuid=recursive`, util-linux 2.39 and kernel 5.12 or later): no setuid file and
   no device node in the imp's files works in the jail. The kernel and the system drive go in
   read-only. A last `--make-rprivate` stops mount events between the jail and the imp's real
   directory: a mount or unmount under `imps/<id>`, such as a ZFS dataset's, does not reach into a
   running jail, and the jail's own unmounts do not reach out.

Firecracker binds its API and vsock sockets in `run/`, so the VM owns `run/` while it is configured
or while a snapshot loads. impd then seals it, giving it back to root, before `InstanceStart` or the
resume: no guest code runs while the VM can change `run/`. The seal then reads `run/`: the two
sockets, and impd's log and pid file as root's regular files with one link each, are all it may
hold. Anything else proves a compromised VM, so the seal deletes nothing while that VM runs: it
fails the start or the wake, and impd kills the VM. The next prepare's sweep, after every process of
the uid is gone, deletes what it left. The seal writes the pid file anew. A sleep writes the
snapshot into new empty files that impd makes for it, and gives them back to root once the VM and
every process of its uid are gone, before anything loads them. impd opens every file of its own
beside a VM, such as the log, the pid file and `meta.json`, with `O_NOFOLLOW` and refuses anything
but a regular file. It checks that each socket is a socket before it connects.

The jailer then makes `/dev/kvm`, `/dev/net/tun` and the rest in the chroot, drops to the uid and
execs Firecracker in place. Firecracker's argv is `--id <id> ... --api-sock <absolute path>`, so
every path is the same inside the jail and out: old snapshots still load, the host reaches the
sockets where it always did, and a restart re-adopts the VM by its API socket as before. A jailed
process can put any socket in its argv, so the reconcile after a restart takes a process as imp X's
VM only when `/proc/<pid>/status` shows it runs as X's jail uid, or as root (an unjailed VM), or
`/proc/<pid>/cgroup` is `/imps/X`. A jail cannot change any of these, so it cannot get another imp's
VM killed or its snapshot dropped as an orphan. The liveness check asks the same of a running imp's
pid, so a recycled pid whose argv a jail forged counts as a lost VM, and no re-adopt moves it into
the imp's cgroup. impd starts it without `--daemonize`, `--new-pid-ns` or `--cgroup`: the pid it
spawns is the VM's, and impd's own cgroup writer stays the only one.

A jailed Firecracker cannot open a tap it does not own, so impd makes each tap with
`ip tuntap add ... user <uid> group <gid>`, and makes it again when its owner differs. impd keeps
the binds while the VM runs and unmounts them when it exits: at a stop, a sleep, a failed start, or
when the liveness check finds it gone. A destroy deletes the jail, and the reconcile at start
deletes the jails of imps that no longer exist. impd still reads `smaps_rollup` and signals the VM
as root.

A jailed VM starts only inside its cgroup: `cgroup.kill` is what stops every process of it at once,
faster than a fork chain can outrun a `/proc` scan. Without a delegated `cpu` controller, or when
the cgroup's setup fails, a jailed boot or wake fails with
`a jailed VM starts only in its own cgroup, and it has none: ...`, and a sleeping imp stays asleep
with its snapshot. On a host without cgroup delegation, set `IMP_JAILER=false`: VMs then run as
root, unjailed and with no CPU or memory limits.

`IMP_JAILER=false` runs Firecracker as root, as before. An unjailed start empties `run/` first, as a
prepare does, so what a jailed VM of the imp left there does not fail its seal. Either way impd
adopts, stops and cleans up after VMs of the other kind, and a snapshot from either wakes under the
other, so the setting can change across a restart.

#### cgroups

`host/scripts/setup-cgroups.sh` runs first in the host container. In a private cgroup v2 namespace
(`/proc/self/cgroup` reads `0::/`), it moves every process to `/init`, enables the `cpu` and
`memory` controllers at the root and makes `imps/` with both enabled. In any other namespace it
changes nothing, and impd stores CPU settings without enforcing them; with the jailer on, no VM
starts there ([the jailer](#the-jailer)). impd makes `imps/<id>` for each VM, writes `cpu.max` and
`cpu.weight`, and starts Firecracker (or the jailer) inside it
(`sh -c 'echo $$ > cgroup.procs; exec setsid firecracker'`), so no VM thread runs outside the limit.
With the memory controller it also writes `memory.max` at the guest's memory plus 256 MiB, or plus
an eighth of the guest above 2 GiB, `memory.swap.max` as 0 and `memory.oom.group` as 1: an OOM kill
takes the whole VM, and the liveness check marks the imp stopped with the error
`its memory limit killed firecracker` when `oom_kill` in `memory.events` rose since the VM's start
or its adopt. A sleep or a wake that the limit cuts short names it the same way, when `oom_kill`
rose during it: a count alone may be an older kill's, in a cgroup that a busy remove kept. The room
above the guest holds Firecracker and the page cache of its disk and snapshot I/O, which the kernel
reclaims at `memory.max` before it kills. A 1536 MiB guest with 1300 MiB in use slept, woke, rewrote
all of it and moved 3 GiB through its disk without an OOM kill. `memory.high` stays `max`: at the
guest plus 128 MiB its throttling made that disk I/O take 20.7 s instead of 9.4 s. `setGuestMib`
moves the limit when the guest's plugged memory changes (memory hot-plug calls it); the size it sets
lasts through a sleep and is forgotten at a stop. A sleep or a wake writes `cpu.max` as `max` while
the snapshot is made or loaded. impd removes the cgroup when the VM exits, and its reconcile at
start removes `imps/*` dirs that no imp owns. The resource sampler reads `cpu.stat`, the tap's byte
counters and `smaps_rollup` once per imp every 5 s, and the presenter and the telemetry read that
cache.

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
the guest process instead of growing impd's memory. If the socket still drops a message (Bun's
backpressure limit), impd closes it with 1011 rather than skip bytes: a session client resumes from
the offset it has ([output offsets](#output-offsets)). Bun pings an idle exec socket and closes it
after 30 s without an answer, so a client that vanished without a close lets go of its session.

A `start` with a `tool` runs a program of the system drive as root instead of `argv`: `tar` runs
`/run/imp/sys/imp-agent tar <argv>` for `imp cp` ([copying files](../guides/cp.md)), needs the agent
from `0.7.0`, and is audited as `cp`. impd acks a tool's stdin with `stdin_ack` once it is on its
way to the guest, and cuts off a client that holds more than 1 MiB plus one 64 KiB frame unacked, so
a large upload to a slow guest disk cannot grow impd's memory. The reverse holds for a tool's
stdout: the client acks it with `stdout_ack` once it is written, and impd stops reading the tool's
output while more than 1 MiB is unacked, so a slow disk on the client's side cannot grow the
client's memory. A tool runs as root in the guest, so it needs `manage` scope on the imp
([tokens](../guides/tokens.md#scopes)); `exec` scope runs only as the image's USER. A ticket socket
cannot start a tool.

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

### Reverse forwards

`imp proxy --reverse` ([guide](../guides/reverse-forwards.md)) uses the same `/tunnel` socket. A
control socket sends `{"type":"listen","name":"box","network":"unix","path":"/tmp/app.sock"}` (or
`"path":null`, or `"network":"tcp","port":n`); impd wakes the imp, opens the agent's
[`listen`](./protocol.md#listen), and answers
`{"type":"listening","listener":id,"path":p,"port":n}`. Each client in the guest arrives as
`{"type":"connection","id":n}`, and the caller opens a new socket with
`{"type":"accept","name":"box","listener":id,"connection":n}`: a relay with the bytes, eofs, acks
and closes of a tunnel.

- **Owner.** impd keeps each forward with the imp's id and its caller (the token or the tailnet
  identity). An accept from another caller, or for an imp that was replaced, gets `NOT_FOUND`.
- **Caps.** At most 64 relays per forward; past that, impd refuses the guest client at once, and an
  accept gets `TUNNEL_LIMIT`. Each relay, and each forward's control socket, also counts toward the
  256 tunnels per imp, so one caller cannot open listeners without limit.
- **Activity.** A relay counts as a `tunnel` connection, so it keeps the imp awake. The control
  socket does not: a forward with no relays lets the imp sleep.
- **The end.** The caller closing the control socket closes the listener, and the agent removes its
  socket. When the listener ends in the guest (a forced sleep, an agent restart), impd closes the
  control socket with 4000; the CLI waits for the imp's `running` state on the event stream, never
  waking it, and listens again.
- **Audit.** A listen is audited as it opens, as `reverse:<path, port or auto>`.

### sessions: detachable consoles

A session is a program on a pty in the guest that outlives its WebSocket
([protocol](./protocol.md#sessions)). On `/exec`, a `start` with a `session` name starts the
session, or attaches to it if it runs; `attach` attaches to one that exists. The socket gets
`started` (with `session`, `created` and `output`), the replay of recent output, then live output.
Closing the socket detaches: the program keeps running. A client that reconnects can resume from the
byte it last saw instead of a replay ([output offsets](#output-offsets)).

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

### Output offsets

A session client that reconnects resumes from the exact byte it last saw, and learns what it missed:
a gap, a new process, or no process, with the cold boot that ended the old one. There is no matching
by content and no exactly-once promise.

**Identities.**

- `executionGeneration`: 32 lowercase hex characters, new each time the agent starts a session's
  process. A sleep and a memory wake keep it; every cold boot ends it, a wake that falls back to a
  cold boot included.
- `bootId`: the guest's `/proc/sys/kernel/random/boot_id`, or, for a guest restored from a
  [boot template](./boot-templates.md), a random UUID the agent draws after its claim, since every
  copy of a template shares the kernel's. A memory wake keeps it; every cold boot changes it.
- `coldBoots`: impd keeps each imp's last 4 cold boots, newest first, as `{ bootId, cause, at }` in
  the `imp_cold_boots` table. A client finds the first boot after its own `bootId`, so a later boot
  (an attach that started a stopped imp) never hides the cause that ended its generation. If a
  client's own `bootId` is not in `coldBoots`, its generation ended at or before the oldest boot
  listed, and impd does not know the cause. That happens after more than 4 cold boots, and after a
  move: the rows stay on the old host, and the first boot on the new one records `start`.
- `previous`: per session name, the agent keeps the last generation that ended and left the name in
  this boot, as `{ executionGeneration, end, exitCode }` (at most 16 names). The agent writes it
  once the process has ended, not at a kill, so `end` and `exitCode` are final. A new generation
  under the same name and the same `bootId` was a replacement.
- Offsets count a generation's pty output bytes from 0.

**Cold-boot causes.**

| Cause           | The boot                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `start`         | A create, a start, or a start after an error state.                                               |
| `wake_fallback` | A wake whose snapshot could not be used, or the next boot after impd found it gone.               |
| `watchdog`      | The [watchdog](#watchdog-silent-agents) restarted a hung guest.                                   |
| `restore`       | A checkpoint restore: the boot of a running imp, or a stopped imp's next boot.                    |
| `recovery`      | The next boot after impd found a running imp's VM gone (a crash or a guest reboot).               |
| `unknown`       | A boot impd has no record of: a VM it adopts, or wakes from memory, that booted before the table. |

impd learns `recovery`, `wake_fallback` and `restore` before the boot that records them, so it keeps
them in `imps.next_boot_cause`; whichever path boots the imp next (an attach, `imps.start`) records
that cause instead of `start`. Every successful cold boot spends the pending cause, even one whose
agent reports no `bootId`. impd lists the boots in the order it recorded them, and `at` is the time
of that record.

**Retention.** The agent keeps exactly the last 262144 bytes of each generation in a raw ring, so
`bufferStart = end - kept` is exact. A resume reads the ring. A fresh attach, without `resumeFrom`,
replays as before: the history skips to the parser's next ground state and sends a mode prelude;
`started.output.offset` is the first byte it sends after `prelude` mode bytes. The history can start
before the ring, so that `offset` can sit below `bufferStart`. Nothing goes to disk, and nothing
outlives the process.

**Resume.** `start` with a `session`, and `attach`, take
`resumeFrom: { executionGeneration, offset }`; `started.output.resume` says how it was met:

- `exact`: the data starts at `resumeFrom.offset`, with no prelude.
- `gap`: the bytes `[from, to)` are gone; the data starts at `to = bufferStart`, with no prelude, so
  it can start inside an escape sequence. A terminal client should attach fresh after a gap; a log
  client keeps the raw bytes.
- `generation_changed`: the named generation is not the one running. The data is the current
  generation from its `bufferStart`, which `firstOffset` equals; `previous` says whether the named
  one was replaced in this boot. A `start` for a name with no process starts one and answers this
  with `firstOffset: 0`.

A resume that names a generation that exited, whose exit no client got yet, attaches to it: the tail
from `resumeFrom.offset`, then `exit`. An offset past `end` fails with `INVALID_RESUME`, data
`{ end, bufferStart }`: a generation never rewinds, so that is a client bug. A resume does not force
a redraw. Each connection is contiguous after `offset`; `exit` and `detached` carry `offset`, the
offset after the last byte the socket sent.

**No process.** `NO_SESSION` keeps its code and gains data `{ bootId, coldBoots, previous? }`. An
attach with `wake: false` to an imp that is not running fails with `INVALID_STATE`, data
`{ state, allowed, coldBoots? }` (no `coldBoots` while it is `creating`), and impd boots nothing.
Without it, an attach to a stopped imp boots it as before, then answers `NO_SESSION` with that boot
first in `coldBoots`; a governor refusal answers `RAM_BUDGET_EXCEEDED`.

**Session list.** `sessions.list` entries gain `continuity`, `executionGeneration`, `bootId`, `end`
and `endObservedAt`. `end` is what impd last saw (the idle loop's copy, or the snapshot meta of a
sleeping imp), so it is a lower bound as of `endObservedAt`.

**Guarantees and limits.** Delivery is at least once across connections: a resume can repeat bytes
the client has, and the client drops bytes below its high-water mark. For one generation, the bytes
at an offset never differ. A disconnected client cannot recover:

- bytes below `bufferStart`;
- any byte of a generation that a cold boot ended;
- the output of an exec without `session`.

A client that needs these keeps what it received.

**Compatibility.** `system.info.features.sessionOffsets` says impd carries offsets; each session's
`continuity` decides for that session, because an imp runs an old agent until its next cold boot. An
agent from before `0.15.0` gives `{ continuity: 'none' }`, today's replay, and ignores `resumeFrom`.
An impd from before offsets sends no `output`, which the client reads as `none`.

### services: guest services

The services API (`services/service-api.ts`) adds, removes, restarts and lists the guest's services
and streams their logs, through the agent ([services](../guides/services.md)). A change wakes or
boots the imp and counts as an exec; a list and a log follow never wake or boot it. It needs agent
protocol `0.10.0`; an older agent answers `AGENT_OUTDATED`.

`services.list` reads the guest's services the same way as `sessions.list`: it never wakes or boots.
The sleep asks the agent for its services list (1 s at most) next to the sessions and writes it to
the same `snapshot/meta.json`. A list answers `{services, recorded}`: a sleeping imp's is that copy,
or no services with `recorded: false` when the sleep has none. A stopped imp is `INVALID_STATE`.

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
- **Login.** Public keys only: keys bound to tokens, held in memory by the token store, then
  `<dataDir>/ssh/authorized_keys`, read again when the file changes (unless
  `IMP_SSH_AUTHORIZED_KEYS=false`). A bound key wins over the same key in the file. The SSH user
  names the imp, and the login needs `exec` on it, checked against the name before the imp lookup
  and against the imp after. The key check, the scope check and the imp lookup give the same
  refusal, and nothing before a verified signature for a known imp touches the imp. Removing a bound
  key or its token ends its connections through the same revocation signals as the API's sockets. A
  login opens an `ssh` connection in the activity tracker and starts the wake; channels wait for it.
  A failed wake reaches each channel as an error on stderr and exit status 255, not as a refused
  login.
- **Sessions.** A shell, a command or the `sftp` subsystem is an agent exec, as `imp exec` is: the
  pty and its size, `TERM`, `LANG` and `LC_*`, and `SSH_CONNECTION` go with it, and resizes and
  signals follow it. SFTP runs `/run/imp/sys/imp-agent sftp` from the system drive. Client input
  pauses until the agent connection has taken the last chunk, so a slow guest holds back the
  client's SSH window instead of growing impd's memory.
- **Forwards.** `direct-tcpip` to the imp's own loopback and `direct-streamlocal` to a socket path
  use the agent's [`dial`](./protocol.md#dial), which connects from inside the guest. The channel
  opens only once the dial worked. X11 is refused.
- **Remote forwards.** A `tcpip-forward` or `streamlocal-forward@openssh.com` listens in the guest
  through the agent's [`listen`](./protocol.md#listen), as the image's user; every bind address maps
  to the guest's `127.0.0.1`, and a port 0 request gets the port the agent picked. Each client
  becomes a `forwarded-tcpip` or `forwarded-streamlocal@openssh.com` channel to the user, relayed
  through `agent.accept`, at most 64 at a time per forward. The listener alone counts as no
  activity; the connection keeps the imp awake anyway. A cancel, the connection's end, or a forced
  sleep closes it, and the client must forward again.
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
`docker build` for `imp image build`, on a context the client uploaded or a directory on the host.
The build route streams an upload to a temp file, checks its size as the bytes come, holds disk room
for it, and lets 4 builds run at once. A client that goes kills its build. It checks the caller and
writes the audit row itself, as the router does for an oRPC call. For `imp image add` it uses the
image the host Docker has, and pulls it when it is missing. Then it exports the filesystem and
writes the image config for the agent. When no image exists, it adds `ubuntu:24.04` as `ubuntu`.
[Storage](./storage.md#images-any-oci-image) covers the pipeline.

The template service (`images/template-service.ts`) makes an image from an imp's disk instead, for
`images.add` with an imp as the source: it clones the disk under the imp's lock, frozen as for a
checkpoint, into `images/imp-<uuidv7>` ([templates](../guides/templates.md)).

### storage: the data layout

The storage module knows where every file under `/var/lib/imp` lives, makes reflink clones (it fails
instead of a full copy), and copies the kernel and system drive into place on start
([system files](./storage.md#system-files)). It also holds the XFS and ZFS backends, the
[disk budget](./storage.md#disk-budget) that every large write takes room from, the
[disk usage](./storage.md#disk-usage) cache, and the [GC](./storage.md#cleanup) with its gate.

### net: taps and the tailnet

The net module turns a slot into addresses (the /30, the tap name, the MAC and the tailnet port),
creates and removes tap devices, and reads `tailscale status` for the node's name and IP.
[Networking](./networking.md) covers the addressing.

### db: SQLite

The db module opens SQLite through Kysely on `bun:sqlite` and runs the migrations in code
(`db/run-migrations.ts`). Its tables are `images`, `imps`, `checkpoints`, the broker's `secrets`,
`grants` and `broker_audit`, `api_audit`, `tokens`, `token_ssh_keys` and `imp_cold_boots`. SQLite
has one connection, so a promise-chain mutex gives it to one caller at a time. Timestamps are
integer milliseconds since the epoch.

The migrations, in order:

| Migration                   | What it adds                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `001_create_initial_schema` | `images`, `imps` and `checkpoints`                                                                                 |
| `002_add_imp_http_port`     | `imps.http_port`, default 8080                                                                                     |
| `003_add_broker`            | `imps.egress_policy` (default `open`), and `secrets`, `grants` and `broker_audit`                                  |
| `004_add_api_audit`         | `api_audit`                                                                                                        |
| `005_add_disk_sizes`        | `imps.disk_bytes` and `disk_grow_pending`, and `checkpoints.disk_bytes`; older rows get 32 GiB                     |
| `006_add_tokens`            | `tokens`, and `api_audit.actor_name`                                                                               |
| `007_add_egress_allow`      | `imps.egress_allow`, the policy's allow-list                                                                       |
| `008_add_token_ssh_keys`    | `token_ssh_keys`, the SSH keys bound to tokens                                                                     |
| `009_add_imp_cpu`           | `imps.cpu_limit`, `cpu_weight` (default 100), `wake_count`, `awake_ms` and `awake_since`                           |
| `010_add_image_source`      | `images.source` (default `oci`) and `source_imp`, and `imps.identity_reset_pending` for a template's copies        |
| `011_add_public_exposure`   | `imps.exposure` (default `tailnet`), `public_auth`, `public_user` and `public_hash` for public imps                |
| `012_add_networks`          | `networks` and `network_members` for [private networks](../guides/networks.md)                                     |
| `013_add_imp_leases`        | `imp_leases`, each owner's hold on an imp ([leases](../guides/leases.md)); a live hold moves to the owner `legacy` |
| `014_add_moves`             | `imps.move_state`, and `move_tickets` and `move_sends` for [moves](./moves.md)                                     |
| `015_add_cold_boots`        | `imp_cold_boots`, each imp's last cold boots, and `imps.next_boot_cause` ([output offsets](#output-offsets))       |

### Other modules

- `egress/`: the nftables table and the DNS resolver for `box` and `none` imps
  ([egress](./networking.md#egress)).
- `https/`: the ACME certificate for `IMP_DOMAIN`, its renewal, and the TLS listeners
  ([HTTPS](../guides/https.md#how-it-works)).
- `tailnet-names/`: opt-in per-imp tailnet names as Tailscale Services
  ([per-imp names](../guides/tailscale.md#per-imp-names)).
- `backup/`: restic runs on the schedule, restores and checks ([backups](./backups.md)).
- `telemetry/`: OpenTelemetry metrics and spans, loaded only when an OTLP endpoint is set
  ([telemetry](../guides/events.md#telemetry)).

### process: helpers

Small helpers: run a command and capture its output, a ticker that runs a task on an interval, never
two at once, and logs a failure without stopping, and a bounded wait for impd's stop steps.
