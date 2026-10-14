# Agent protocol reference

<!-- Generated from imp/agent/v1/agent.proto by bun run gen:proto. Edit the schema, not this file. -->

The message bodies of the agent protocol, which impd and the guest agent speak over vsock
(docs/architecture/guest/protocol.md). This file is the source of truth: `bun run gen:proto` writes
the Go types, impd's TypeScript types and the reference in docs/reference/agent-protocol.md from it.

The wire stays JSON: each side writes the proto3 JSON form with the field names below, and reads it
back ignoring the fields it does not know. Frames, the type byte and the length prefix, stay
hand-written in each codec.

Two rules keep the JSON what agents before this schema sent and read:

- A 64-bit count (a byte offset, a size, an inode, a time in Unix ms) is a double. The JSON form of
  int64 is a string, which an older agent rejects in a request; a double stays a JSON number, exact
  up to 2^53, the most impd's JavaScript holds anyway.
- A field the sender leaves out when it has nothing to say is optional. The agent writes every field
  that is not, zero or not; impd leaves a zero out, which an agent reads as zero.

In each table, a field marked always is in every message the agent writes, zero or not; impd leaves
a zero out, which reads as zero. A field marked when set appears only when its sender sets it, and a
list appears as [] or not at all.

## Request

The REQUEST frame: the first frame on every connection. Each op reads its own fields and leaves the
rest unset.

| Field           | Type                      | Presence | Description                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `op`            | string                    | always   | The operation: ping, exec, exec.outer, freeze, thaw, activity, resumed, shutdown, grow, claim, dial, listen, agent.listen, agent.accept, session.attach, session.kill, session.tap, services.list, services.add, services.remove, services.restart, services.logs, files.write or files.remove. |
| `argv`          | list of string            | list     | exec, exec.outer: the command and its arguments.                                                                                                                                                                                                                                                |
| `env`           | list of string            | list     | exec, exec.outer: KEY=value entries added to the environment.                                                                                                                                                                                                                                   |
| `cwd`           | string                    | when set | exec, exec.outer: the working directory.                                                                                                                                                                                                                                                        |
| `tty`           | bool                      | when set | exec, exec.outer: whether the command gets a tty.                                                                                                                                                                                                                                               |
| `cols`          | uint32                    | when set | exec, exec.outer, session.attach: the tty's width.                                                                                                                                                                                                                                              |
| `rows`          | uint32                    | when set | exec, exec.outer, session.attach: the tty's height.                                                                                                                                                                                                                                             |
| `user`          | string                    | when set | exec, exec.outer: the user the command runs as.                                                                                                                                                                                                                                                 |
| `kill_grace_ms` | uint32                    | when set | exec, exec.outer: once a host stop signal arrives and the process exits, the rest of its process group gets this long, counted from the signal, before SIGKILL. 0 leaves the group alone.                                                                                                       |
| `session`       | string                    | when set | exec, session.attach, session.kill, session.tap: the session name.                                                                                                                                                                                                                              |
| `log`           | bool                      | when set | exec that starts a session: impd keeps a log of its output, so the agent marks it for a tap.                                                                                                                                                                                                    |
| `resume_from`   | [ResumeFrom](#resumefrom) | when set | exec with a session, session.attach, session.tap: resume the output after the last byte the client saw, rather than replay it.                                                                                                                                                                  |
| `timeout_ms`    | uint32                    | when set | freeze: auto-thaw after this many ms (default 30000).                                                                                                                                                                                                                                           |
| `unix_ms`       | double                    | when set | resumed: the host's wall clock, in Unix ms.                                                                                                                                                                                                                                                     |
| `network`       | string                    | when set | dial, listen: "tcp" or "unix".                                                                                                                                                                                                                                                                  |
| `address`       | string                    | when set | dial: "host:port" for tcp, or a socket path for unix. listen: "127.0.0.1:port" for tcp, or for unix a path, or "" for one the agent makes.                                                                                                                                                      |
| `listener`      | string                    | when set | agent.accept: the listener a CONNECTION frame came on.                                                                                                                                                                                                                                          |
| `connection`    | uint32                    | when set | agent.accept: the id the CONNECTION frame named.                                                                                                                                                                                                                                                |
| `disk_bytes`    | double                    | when set | grow: the disk's new size in bytes.                                                                                                                                                                                                                                                             |
| `claim`         | [Claim](#claim)           | when set | claim: the values a cold boot reads from the kernel cmdline, and more.                                                                                                                                                                                                                          |
| `service`       | string                    | when set | services.remove, services.restart, services.logs: the service name.                                                                                                                                                                                                                             |
| `def`           | [ServiceDef](#servicedef) | when set | services.add: the definition.                                                                                                                                                                                                                                                                   |
| `replace`       | bool                      | when set | services.add: whether the definition may replace one of the same name.                                                                                                                                                                                                                          |
| `lines`         | uint32                    | when set | services.logs: how many lines of the log to send first.                                                                                                                                                                                                                                         |
| `follow`        | bool                      | when set | services.logs: whether to keep sending what the service writes.                                                                                                                                                                                                                                 |
| `cursor`        | [LogCursor](#logcursor)   | when set | services.logs: send everything after this place, in place of lines.                                                                                                                                                                                                                             |
| `path`          | string                    | when set | files.write, files.remove: the file's path under the read-only files root, 1 to 8 segments joined by "/" (docs/architecture/guest/agent.md#read-only-files).                                                                                                                                    |
| `data`          | bytes (base64)            | when set | files.write: the file's content, at most 512 KiB.                                                                                                                                                                                                                                               |

## ResumeFrom

A session's generation, and the offset of the first output byte the client lacks.

| Field                  | Type   | Presence | Description |
| ---------------------- | ------ | -------- | ----------- |
| `execution_generation` | string | always   |             |
| `offset`               | double | always   |             |

## LogCursor

A place in a service's log: the file, by inode, and the offset after the last byte sent. The CURSOR
frame, and a services.logs request.

| Field    | Type   | Presence | Description |
| -------- | ------ | -------- | ----------- |
| `inode`  | double | always   |             |
| `offset` | double | always   |             |

## Claim

What a guest restored from a boot template needs to become one imp
(docs/architecture/lifecycle/boot-templates.md#restore). The seed is mixed into the kernel's entropy
pool before the CRNG reseeds.

| Field            | Type           | Presence | Description                                        |
| ---------------- | -------------- | -------- | -------------------------------------------------- |
| `id`             | string         | always   |                                                    |
| `hostname`       | string         | always   |                                                    |
| `ip`             | string         | always   | an address with its prefix length, and the gateway |
| `gw`             | string         | always   |                                                    |
| `ip6`            | string         | when set |                                                    |
| `gw6`            | string         | when set |                                                    |
| `dns`            | list of string | list     |                                                    |
| `mac`            | string         | always   |                                                    |
| `disk_bytes`     | double         | when set |                                                    |
| `unix_ms`        | double         | always   |                                                    |
| `seed`           | bytes (base64) | always   | base64 in JSON                                     |
| `reset_identity` | bool           | when set |                                                    |

## ErrorResponse

The RESPONSE payload for a failed request.

| Field   | Type            | Presence | Description |
| ------- | --------------- | -------- | ----------- |
| `error` | [Error](#error) | when set |             |

## Error

| Field     | Type                    | Presence | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`    | string                  | always   | BAD_REQUEST, UNKNOWN_OP, EXEC_FAILED, INNER_DOWN (the inner container, where every process runs, is down), FROZEN, POWERING_OFF, INTERNAL, NO_SESSION, INVALID_RESUME (a resume named an offset past the end of the generation it names), SESSION_LIMIT, DIAL_FAILED, NO_CONNECTION, LISTEN_FAILED, NO_SERVICE, SERVICE_EXISTS or NO_SPACE (the read-only files have no room for a write). A reader keeps it a string: a newer agent may send a code it does not know. |
| `message` | string                  | always   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `data`    | [ErrorData](#errordata) | when set | the code's detail, for NO_SESSION and INVALID_RESUME                                                                                                                                                                                                                                                                                                                                                                                                                   |

## ErrorData

The detail of an error. NO_SESSION sets boot_id, this boot, and previous, the generation that last
ran under the name in it. INVALID_RESUME sets end and buffer_start, where the generation's output
stands.

| Field          | Type                  | Presence | Description |
| -------------- | --------------------- | -------- | ----------- |
| `boot_id`      | string                | when set |             |
| `previous`     | [Previous](#previous) | when set |             |
| `end`          | double                | when set |             |
| `buffer_start` | double                | when set |             |

## Ping

The RESPONSE to ping.

| Field            | Type                        | Presence | Description                                                                                                  |
| ---------------- | --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `ok`             | bool                        | always   |                                                                                                              |
| `version`        | string                      | always   | the agent protocol version                                                                                   |
| `uptime_ms`      | double                      | when set | unset when the guest clock cannot be read: impd then skips its young-guest wait before a sleep               |
| `identity_reset` | string                      | when set | set on a boot that reset a template copy's identity: ok, or failed when impd must ask again on the next boot |
| `stage`          | string                      | when set | "template" while the agent waits for a claim; unset once it serves                                           |
| `inner`          | [InnerStatus](#innerstatus) | when set | the inner container's state; unset by an agent before 0.14.0                                                 |
| `boot_id`        | string                      | when set | the guest kernel's boot_id: a wake from memory keeps it, every cold boot changes it                          |

## InnerStatus

The inner container's state: whether it runs, how often it started again after its init died, and
why the last start failed.

| Field        | Type   | Presence | Description |
| ------------ | ------ | -------- | ----------- |
| `up`         | bool   | always   |             |
| `restarts`   | uint32 | always   |             |
| `last_error` | string | when set |             |

## OK

The RESPONSE to a unary request that has nothing more to say.

| Field | Type | Presence | Description |
| ----- | ---- | -------- | ----------- |
| `ok`  | bool | always   |             |

## FilesRemoved

The RESPONSE to files.remove.

| Field     | Type | Presence | Description                        |
| --------- | ---- | -------- | ---------------------------------- |
| `removed` | bool | always   | whether a file was there to remove |

## Listening

The RESPONSE to agent.listen and listen.

| Field      | Type   | Presence | Description                                          |
| ---------- | ------ | -------- | ---------------------------------------------------- |
| `ok`       | bool   | always   |                                                      |
| `path`     | string | when set | the unix socket (for agent.listen, SSH_AUTH_SOCK)    |
| `port`     | uint32 | when set | the TCP port, which a request for port 0 learns here |
| `listener` | string | always   |                                                      |

## Connection

The CONNECTION payload: a client waits on the socket for an agent.accept with this id.

| Field | Type   | Presence | Description |
| ----- | ------ | -------- | ----------- |
| `id`  | uint32 | always   |             |

## Activity

The RESPONSE to activity.

| Field             | Type                                | Presence | Description                                          |
| ----------------- | ----------------------------------- | -------- | ---------------------------------------------------- |
| `tcp_established` | uint32                              | always   |                                                      |
| `exec_sessions`   | uint32                              | always   | open exec, exec.outer and session.attach connections |
| `load1`           | double                              | always   |                                                      |
| `sessions`        | list of [SessionInfo](#sessioninfo) | list     |                                                      |

## SessionInfo

A session as activity lists it.

| Field                  | Type           | Presence | Description                                                                         |
| ---------------------- | -------------- | -------- | ----------------------------------------------------------------------------------- |
| `name`                 | string         | always   |                                                                                     |
| `pid`                  | int32          | always   |                                                                                     |
| `argv`                 | list of string | list     |                                                                                     |
| `state`                | string         | always   | running or exited                                                                   |
| `attached`             | bool           | always   |                                                                                     |
| `cols`                 | uint32         | always   |                                                                                     |
| `rows`                 | uint32         | always   |                                                                                     |
| `started_unix_ms`      | double         | always   | the guest wall clock when the session started, in Unix ms                           |
| `exit`                 | [Exit](#exit)  | when set | set once the process exited and its output drained                                  |
| `execution_generation` | string         | always   | this run of the session's process, and the offset after the last output byte so far |
| `boot_id`              | string         | always   |                                                                                     |
| `end`                  | double         | always   |                                                                                     |
| `log`                  | bool           | when set | set for a session started with log, which impd taps                                 |

## ServiceDef

One services.d file, and a service's definition in services.add and services.list. The file name is
the name; a name field in the file is ignored.

| Field     | Type           | Presence | Description                                                                           |
| --------- | -------------- | -------- | ------------------------------------------------------------------------------------- |
| `name`    | string         | when set |                                                                                       |
| `argv`    | list of string | list     |                                                                                       |
| `env`     | list of string | list     |                                                                                       |
| `cwd`     | string         | when set |                                                                                       |
| `user`    | string         | when set |                                                                                       |
| `restart` | string         | when set | always (the default), on-failure or never                                             |
| `source`  | string         | when set | api for a file services.add wrote, else image; the agent sets it, impd never sends it |

## ServiceStatus

| Field       | Type                      | Presence | Description                                                                                                                                                                                  |
| ----------- | ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | string                    | always   |                                                                                                                                                                                              |
| `state`     | string                    | always   | starting, running, backoff, stopped or exited                                                                                                                                                |
| `pid`       | int32                     | when set |                                                                                                                                                                                              |
| `restarts`  | uint32                    | always   |                                                                                                                                                                                              |
| `last_exit` | [Exit](#exit)             | when set |                                                                                                                                                                                              |
| `def`       | [ServiceDef](#servicedef) | when set | the definition the service runs, as read from its file; unset by an agent before the services API                                                                                            |
| `root`      | bool                      | when set | whether the service runs as uid 0, or as a user the guest cannot resolve; the agent always sets it, and a reader takes an agent from before the services API, which leaves it unset, as root |

## ServicesList

The RESPONSE to services.list.

| Field        | Type                                    | Presence | Description                                           |
| ------------ | --------------------------------------- | -------- | ----------------------------------------------------- |
| `services`   | list of [ServiceStatus](#servicestatus) | list     |                                                       |
| `image_user` | string                                  | always   | the image's user, which a service without one runs as |

## Started

The STARTED payload.

| Field           | Type              | Presence | Description                                                                                                                                  |
| --------------- | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pid`           | int32             | always   |                                                                                                                                              |
| `session`       | string            | when set | set on a session connection; created is false when the connection attached to a session that already ran                                     |
| `created`       | bool              | when set |                                                                                                                                              |
| `kill_grace_ms` | uint32            | when set | echoes a non-tty exec's kill_grace_ms, as clamped, so the host knows this agent kills a stopped command's group; older agents leave it unset |
| `output`        | [Output](#output) | when set | set on a session connection: where its output stands, and where the data that follows starts                                                 |

## Output

Places a session connection's data in the generation's output. Offsets count the pty output bytes of
one generation from 0.

| Field                  | Type                  | Presence | Description                                                                                                                 |
| ---------------------- | --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `boot_id`              | string                | always   |                                                                                                                             |
| `execution_generation` | string                | always   |                                                                                                                             |
| `buffer_start`         | double                | always   | the first byte the raw ring still holds, and the offset after the last byte written so far                                  |
| `end`                  | double                | always   |                                                                                                                             |
| `offset`               | double                | always   | the offset of the first data byte this connection sends; prelude counts the mode bytes sent before it, which have no offset |
| `prelude`              | uint32                | always   |                                                                                                                             |
| `previous`             | [Previous](#previous) | when set | the last generation under this name that ended and was replaced or removed, in this boot                                    |
| `resume`               | [Resume](#resume)     | when set | set when the request had resume_from                                                                                        |
| `log`                  | bool                  | when set | set for a session started with log                                                                                          |

## Previous

A generation whose process ended: its end and exit are final.

| Field                  | Type          | Presence | Description |
| ---------------------- | ------------- | -------- | ----------- |
| `execution_generation` | string        | always   |             |
| `end`                  | double        | always   |             |
| `exit`                 | [Exit](#exit) | when set |             |

## Resume

How a resume_from was met. Each kind sets only its own fields: exact sets none; gap sets from and
to, the bytes [from, to) that are gone; generation_changed sets execution_generation and
first_offset, when the named generation is not the one running and the data is this one's from
first_offset.

| Field                  | Type   | Presence | Description |
| ---------------------- | ------ | -------- | ----------- |
| `kind`                 | string | always   |             |
| `from`                 | double | when set |             |
| `to`                   | double | when set |             |
| `execution_generation` | string | when set |             |
| `first_offset`         | double | when set |             |

## Detached

The DETACHED payload: why the guest ended a session connection without an EXIT. taken_over or slow.

| Field    | Type   | Presence | Description |
| -------- | ------ | -------- | ----------- |
| `reason` | string | always   |             |

## Resize

The RESIZE frame: a tty's size.

| Field  | Type   | Presence | Description |
| ------ | ------ | -------- | ----------- |
| `cols` | uint32 | always   |             |
| `rows` | uint32 | always   |             |

## Signal

The SIGNAL frame: a Linux signal number for the process group.

| Field    | Type  | Presence | Description |
| -------- | ----- | -------- | ----------- |
| `signal` | int32 | always   |             |

## Exit

The EXIT payload: how a process ended. When signal is set, code is 128+signal, as a shell reports
it.

| Field    | Type  | Presence | Description |
| -------- | ----- | -------- | ----------- |
| `code`   | int32 | always   |             |
| `signal` | int32 | always   |             |
