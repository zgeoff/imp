# Agent protocol

impd and the guest agent (`imp-agent`, PID 1) talk over vsock. Firecracker exposes the guest vsock
as a unix socket; the host connects to it, sends `CONNECT 1024`, and then speaks this protocol. Each
connection carries one request. The first frame is a JSON request; exec connections then carry
binary frames for stdin, output, resizes, signals and the exit.

Version `0.2.0`. The Go side is `agent/internal/proto`; the host side is the agent client in impd
([daemon](./daemon.md#agent-client-the-vsock-client)).

## Transport

Firecracker exposes the guest vsock as a unix socket (`run/vsock.sock`). To reach the agent:

1. Connect to the unix socket.
2. Write `CONNECT 1024\n`.
3. Read one line. `OK <host-port>\n` means the stream is now connected to the agent. Anything else,
   or EOF, means the agent is not listening yet (during boot) — retry.

**One request per connection.** The host sends one REQUEST frame. The guest answers and closes the
connection. To make another request, connect again.

### Snapshot restore

A snapshot resets the vsock transport. When the VM resumes, the guest closes every open connection,
so in-flight requests fail on the host side and exec sessions get the host-disconnect treatment
below. The agent's listen socket survives; if `accept` fails anyway, the agent listens again (with
backoff) instead of exiting. After a wake the host connects again as usual.

## Frames

Every message after the handshake is a frame:

```
+---------+----------------------+-----------------+
| type u8 | length u32 (big-end) | payload [length] |
+---------+----------------------+-----------------+
```

- `length` is the payload length only (not the 5-byte header).
- The maximum payload is 1 MiB (1048576). A receiver rejects a larger frame and closes the
  connection. Senders split larger data into several frames.
- JSON payloads are UTF-8 JSON objects. Raw payloads are opaque bytes.

| Type | Name        | Direction    | Payload                                          |
| ---: | ----------- | ------------ | ------------------------------------------------ |
|    1 | `REQUEST`   | host → guest | JSON request; always the first frame             |
|    2 | `RESPONSE`  | guest → host | JSON; the result of a unary request, or an error |
|    3 | `STDIN`     | host → guest | raw bytes for the process stdin                  |
|    4 | `STDIN_EOF` | host → guest | empty; closes the process stdin                  |
|    5 | `RESIZE`    | host → guest | JSON `{"cols":n,"rows":n}`                       |
|    6 | `SIGNAL`    | host → guest | JSON `{"signal":n}` (Linux signal number)        |
|    7 | `STARTED`   | guest → host | JSON `{"pid":n}`                                 |
|    8 | `STDOUT`    | guest → host | raw bytes                                        |
|    9 | `STDERR`    | guest → host | raw bytes                                        |
|   10 | `EXIT`      | guest → host | JSON `{"code":n,"signal":n}`; the last frame     |
|   11 | `DETACHED`  | guest → host | JSON `{"reason":s}`; ends a session connection   |

Unknown frame types from the host are ignored.

## Errors

A failed request gets a RESPONSE with an `error` object, then the guest closes the connection:

```json
{ "error": { "code": "EXEC_FAILED", "message": "start foo: no such file or directory" } }
```

| Code            | Meaning                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| `BAD_REQUEST`   | The first frame is not a REQUEST, its JSON is invalid, or a field is missing or invalid. |
| `UNKNOWN_OP`    | The `op` is not known to this agent.                                                     |
| `EXEC_FAILED`   | `exec` could not start the process (bad argv, cwd, or user).                             |
| `NO_SESSION`    | `session.attach` or `session.kill` named no session.                                     |
| `SESSION_LIMIT` | A new session would be the 17th.                                                         |
| `FROZEN`        | `freeze` found the root filesystem already frozen.                                       |
| `POWERING_OFF`  | `freeze` arrived after a poweroff started.                                               |
| `INTERNAL`      | A system call failed (for example `FIFREEZE`).                                           |

A successful RESPONSE never has an `error` key.

## Unary requests

The host sends REQUEST; the guest sends one RESPONSE and closes.

### `ping`

```json
→ {"op":"ping"}
← {"ok":true,"version":"0.1.0","uptime_ms":265}
```

`uptime_ms` is `CLOCK_BOOTTIME`. The host uses `ping` as the boot-readiness probe.

### `freeze` / `thaw`

```json
→ {"op":"freeze","timeout_ms":30000}
← {"ok":true}
→ {"op":"thaw"}
← {"ok":true}
```

`freeze` runs `FIFREEZE` on `/`, which syncs the filesystem first. The host then takes the reflink
checkpoint and sends `thaw` (`FITHAW`). If no `thaw` arrives within `timeout_ms` (default 30000),
the agent thaws by itself, so a host crash cannot leave the guest frozen. `thaw` on an unfrozen
filesystem succeeds. `freeze` on a frozen filesystem fails with `FROZEN` and leaves the first
freeze's auto-thaw as it was. Once `shutdown` (or a signal) starts a poweroff, the agent thaws, and
`freeze` fails with `POWERING_OFF`.

### `activity`

```json
→ {"op":"activity"}
← {"tcp_established":1,"exec_sessions":0,"load1":0.08,"sessions":[
    {"name":"main","pid":301,"argv":["bash","-l"],"state":"running","attached":false,
     "cols":120,"rows":40,"started_unix_ms":1790000000000}]}
```

- `tcp_established`: ESTABLISHED sockets in `/proc/net/tcp` and `/proc/net/tcp6`, without loopback
  ones (`127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`). The agent's own vsock connections are not TCP
  and never count.
- `exec_sessions`: `exec` and `session.attach` connections that are open now. A detached session is
  not a connection and does not count.
- `load1`: the 1-minute load average.
- `sessions`: every [session](#sessions), sorted by name. `state` is `running` or `exited`; an
  exited session also has `exit` (an EXIT object) until a viewer gets it. `started_unix_ms` is the
  guest wall clock at the start. The host polls `activity` every 2 s, so it doubles as the session
  list.

### `resumed`

```json
→ {"op":"resumed","unix_ms":1790000000000}
← {"ok":true}
```

Sets `CLOCK_REALTIME` to `unix_ms`. The host sends it after a snapshot restore, because the guest
clock stops while the VM sleeps. Send it right after the first `ping` that answers. Only the wall
clock moves: `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` (and so `uptime_ms`) do not count the time
asleep.

### `services.list`

```json
→ {"op":"services.list"}
← {"services":[{"name":"dockerd","state":"running","pid":212,"restarts":0}]}
```

`state` is `starting`, `running`, `backoff`, `exited` or `stopped`. `last_exit` (an EXIT object) is
present after the first exit.

### `shutdown`

```json
→ {"op":"shutdown"}
← {"ok":true}
```

The guest replies and closes the connection, then stops services (SIGTERM, SIGKILL after 5 s), sends
SIGTERM to all other processes (SIGKILL after 3 s), syncs, remounts `/` read-only and reboots. With
`reboot=k` on the kernel command line, the reboot makes Firecracker exit. The host waits for the
Firecracker process to exit.

## `exec`

```json
→ REQUEST {"op":"exec","argv":["sh","-c","echo hi"],"env":["FOO=1"],
           "cwd":"","tty":false,"cols":0,"rows":0,"user":""}
```

| Field          | Meaning                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `argv`         | Required. `argv[0]` is looked up in the `PATH` of the final env.                |
| `env`          | `KEY=VALUE` entries. They override the image default env key by key.            |
| `cwd`          | Working directory. Default: the image `workdir`, else `$HOME`, else `/`.        |
| `tty`          | Run on a new pty. stdout and stderr then both arrive as STDOUT.                 |
| `cols`, `rows` | The initial pty size. Default 80x24. Ignored without `tty`.                     |
| `user`         | `name`, `uid`, `name:group` or `uid:gid`. Default: the image `user`, else root. |

The default env comes from `/etc/imp/image.json` (`{"env":[],"workdir":"","user":""}`), merged over
`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `HOME=/root` and
`TERM=xterm-256color`. With `user` set, `HOME` comes from `/etc/passwd`.

Sequence:

1. The guest starts the process. If that fails, it sends RESPONSE with `EXEC_FAILED` and closes.
   Otherwise it sends STARTED `{"pid":n}`.
2. Both sides stream:
   - host → guest: STDIN, STDIN_EOF, RESIZE, SIGNAL.
   - guest → host: STDOUT, STDERR.
3. When the process exits, the guest forwards remaining output and sends EXIT. It then reads (and
   ignores) host frames until the host closes, for at most 2 s, and closes the connection. A host
   frame that races the exit, such as STDIN_EOF, so never hits a closed socket.

Details:

- **Process group.** The process leads its own process group (with `tty`, its own session, with the
  pty as controlling terminal). SIGNAL goes to the whole group.
- **stdin.** Without `tty`, STDIN_EOF closes the stdin pipe. With `tty`, STDIN_EOF is ignored; send
  `\x04` as STDIN for an EOF at the terminal.
- **Output after exit.** Output is forwarded until both streams reach EOF, or for at most 500 ms
  after the process exits. Background children that keep stdout open cannot hold the session open.
- **EXIT.** `code` is the exit status. If a signal killed the process, `signal` is its number and
  `code` is `128 + signal`, as a shell reports it.
- **Host disconnect.** If the connection closes before the process exits, the guest sends SIGHUP to
  the process group, as a terminal hangup would. If the process is still running 1 s later (it
  ignores SIGHUP), the guest closes its stdio and ends the session without an EXIT frame; the
  process keeps running and no longer counts in `exec_sessions`.
- **Flow control.** There is none beyond the stream itself. The guest queues STDIN that the process
  has not read yet (up to 1024 frames or 4 MiB), and keeps applying RESIZE and SIGNAL frames
  meanwhile. Past that it stops reading the connection until the process reads stdin or exits, so
  later frames of any type wait.

## Sessions

A session is a program on a pty that outlives its connection, for a console you can close and
reattach to later. The agent keeps up to 16 sessions; an exited session whose EXIT no viewer got yet
counts too. A name matches `^[a-z0-9][a-z0-9-]{0,31}$`.

### Start or attach

An `exec` request with a `session` name starts the session, or attaches to it if it runs:

```json
→ REQUEST {"op":"exec","session":"main","argv":["bash","-l"],"tty":true,"cols":120,"rows":40}
← STARTED {"pid":301,"session":"main","created":true}
```

`tty` must be true. If the name belongs to a running session, the request attaches and its `argv`,
`env`, `cwd` and `user` are ignored (`created` is false). If it belongs to an exited session, a new
session replaces it. `session.attach` only attaches, and fails with `NO_SESSION` if there is no
session of that name:

```json
→ REQUEST {"op":"session.attach","session":"main","cols":120,"rows":40}
← STARTED {"pid":301,"session":"main"}
```

### The viewer

A session has at most one connection, its viewer. After STARTED the viewer gets:

1. A replay: one or more STDOUT frames with the recent output, about the last 256–512 KiB. It starts
   with the terminal modes in effect where the kept output starts (alternate screen, mouse modes,
   bracketed paste, application cursor keys, a hidden cursor, focus events and the kitty keyboard
   flags), so the viewer's terminal ends in the modes the program set last. The kept output starts
   between escape sequences and characters, never inside one.
2. Live output as STDOUT frames.
3. EXIT when the process exits, or DETACHED when the agent drops the viewer.

The host sends STDIN, RESIZE and SIGNAL as for `exec`. STDIN_EOF is ignored, as with any tty.

The replay is the raw output, written for the terminal size of its time. To redraw a full-screen
program, an attach to a running session resizes the pty to the viewer's `cols` and `rows`. If the
size is the same, the agent first sets one row less, so the program always gets SIGWINCH. A program
that does not redraw on SIGWINCH shows the replay only.

### Detach

- **Host closes the connection.** That is a detach: the process gets no signal and keeps running. A
  vsock reset on a snapshot restore is a detach too.
- **Takeover.** A new attach makes the old viewer get `DETACHED {"reason":"taken_over"}`, and the
  agent closes its connection.
- **A slow viewer.** The agent never waits for a viewer. A viewer more than 2 MiB behind is dropped
  with `DETACHED {"reason":"slow"}` and its queued output is discarded. The program keeps writing to
  the session.

### Exit

When the process exits, the agent forwards the remaining output (for at most 500 ms, as for `exec`)
and sends EXIT to the viewer, then waits up to 2 s for the host to close. The session is then gone.
With no viewer attached, the session stays as `exited`; the next attach gets the replay and EXIT,
and the session is gone after that.

### `session.kill`

```json
→ {"op":"session.kill","session":"main"}
← {"ok":true}
```

The name is free at once. The process group gets SIGHUP, and SIGKILL 2 s later if the process is
still running. An attached viewer gets the EXIT. `NO_SESSION` if there is no session of that name.
