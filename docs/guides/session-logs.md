# Session logs

A session started with `log` keeps its output on the host. A client can then read output that the
agent's ring no longer holds, and the output of a generation that has ended: after the session
exited, after the imp stopped, and after a cold boot. The log uses the same offsets and `gap` rules
as a [resume](../architecture/daemon.md#output-offsets). Nothing changes for a session started
without `log`.

```sh
imp console dev --session build --log      # start a logged session (attaching changes nothing)
imp sessions logs dev                       # every log of the imp, newest first
imp sessions log dev build                  # the newest log of `build`, raw, to stdout
imp sessions log dev build <generation> --from 1048576
imp sessions log-rm dev build               # delete the logs of `build`
```

None of these calls wakes or boots the imp: the logs live on the host.

Only `log: true` on the start that creates a session turns its log on. A session that already runs
stays unlogged, even when a later start with `log` attaches to it, and every session is unlogged by
default.

Each log belongs to one generation, and every read names it. A cold boot, a restore or a replacement
starts a new generation, and so a new log: impd never joins two generations into one output. Bytes a
log does not hold are always reported as a `gap`, never skipped.

## API

| Where                  | What                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/exec` `start`        | `log: true`, with a `session` that this start creates. `started.output.log` is `{ enabled: true }` when impd keeps the log, and `{ enabled: false }` when the imp's agent predates session logs (it runs until the imp's next cold boot). An attach to a logged session also shows it. |
| `sessions.logs`        | `{ name, session? }` → every generation's log: `session`, `executionGeneration`, `bootId`, `state` (`live` or `ended`), `logStart`, `logEnd`, `bytes`, `end?`, `exitCode?`, `complete`, `stopped?`, `startedAt`, `endedAt?`.                                                           |
| `sessions.readLog`     | `{ name, session, executionGeneration, from, limit? }` → `{ offset, gap?, data, log }`. `data` is a `Blob` of raw pty output, at most 1 MiB, from one segment; read on from `offset + data.size` until `data` is empty.                                                                |
| `sessions.deleteLog`   | `{ name, session?, executionGeneration? }` → `{ deleted }`. A live generation stops being logged.                                                                                                                                                                                      |
| `system.info.features` | `sessionLog: true`. An older impd drops `log` unread, so a client checks this first.                                                                                                                                                                                                   |

The read rules are the ring's rules:

- `from` below `logStart`, or in a hole the tap left, is a `gap`: the bytes `[from, offset)` are not
  in the log, and the data starts at `offset`. It can start inside an escape sequence.
- `from` equal to `logEnd` returns no data.
- `from` past `logEnd` fails with `INVALID_RESUME`, data `{ end: logEnd, bufferStart: logStart }`.
- A generation that has no log fails with `NOT_FOUND`.

`complete` is true when the log holds every byte of a generation that ended with an exit that impd
saw: `logStart` is 0, there is no hole, and `logEnd` equals `end`. A generation that a stop or a
cold boot ended has no `end`, as the agent never reported one. Its log ends where impd's tap last
read.

In the SDK (`@zgeoff/imp-client`), `openExec` and `openConsole` take `log`, and `client.sessions`
has `logs`, `readLog` and `deleteLog`.

## What is kept

| Variable                       | Default | Bound                                                                                         |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------- |
| `IMP_SESSION_LOG_MAX_MIB`      | 16      | One generation's log. It keeps at least half of it, the newest output; older segments go.     |
| `IMP_SESSION_LOG_IMP_MAX_MIB`  | 64      | One imp's logs together. Ended generations go first, oldest first; then the largest live one. |
| `IMP_SESSION_LOG_MAX_AGE_DAYS` | 7       | An ended generation's log goes this long after it ended.                                      |

A log writes in segments of half its bound, and each new segment checks the host's free space
against `IMP_DISK_RESERVE_GIB`, as every other write does
([disk reserve](../architecture/storage.md#disk-sizes)). A segment the reserve refuses stops the log
for good: `stopped: 'disk_full'`, and the session runs on unlogged.

A logged session's program waits for impd, as on a slow terminal, rather than lose bytes: the agent
holds its output while its 256 KiB ring could drop bytes impd has not read, for at most 5 s at a
time. Past that, as when impd is down, the session runs on and the log gets a hole.

A host crash loses at most the last second of output, and the log never returns bytes that did not
reach the disk ([daemon](../architecture/daemon.md#session-logs)).

## What survives

| Event                  | The log                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Sleep and wake         | Goes on. A sleep detaches impd's tap; impd taps again after the wake, from the log's end. |
| impd restart           | Goes on from the log's end. Output past 256 KiB and 5 s while impd was down is a hole.    |
| Stop, crash, cold boot | The generation ends; its log stays.                                                       |
| Checkpoint restore     | Stays. A restore is a cold boot: the running generation ends.                             |
| Fork, template         | Not copied. A fork or a template is a new disk; the log is not on the disk.               |
| Backup and restore     | Not backed up.                                                                            |
| Move to another host   | Not carried. The source deletes it with its copy of the imp.                              |
| `imp rm`               | Deleted.                                                                                  |

## Privacy

Output can hold secrets: a token a program prints, a password typed at a prompt that echoes.

- Reading a log needs `exec` on the imp, as attaching does, and the audit log records each read.
  Listing the logs needs `read`; the list holds no output.
- The log lives under the imp's directory on the host, `imps/<id>/session-logs/`, mode 0700, which
  the guest cannot reach. It goes nowhere else: no backup, fork, template or move carries it.
- `imp sessions log-rm`, the age bound and `imp rm` delete it. A live generation that is deleted is
  not logged again for as long as impd runs; after an impd restart, impd logs it again from the
  agent's ring, at most its last 256 KiB.

Start a session without `log` when its output should never reach the host's disk.
