# MCP server

`imp mcp` gives a coding agent imps as tools. The agent can create an imp, run a test suite in it,
checkpoint before a risky change, fork to try two fixes, and destroy what it does not need. The
server speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio. It reaches
impd as the rest of the CLI does: the current saved host, `--host`, or `IMP_URL` and `IMP_TOKEN`
([configuration](./configuration.md)).

## Add it to an agent

The server needs a guard: the imps it may touch. Give the agent a prefix of its own:

```sh
claude mcp add imp -- imp mcp --prefix agent-
```

| Flag              | The tools may touch                                                    |
| ----------------- | ---------------------------------------------------------------------- |
| `--prefix agent-` | imps named `agent-…`; a create without a name gets `agent-` and 8 more |
| `--allow a,b`     | the imps `a` and `b`; adds to `--prefix` when both are given           |
| `--all`           | every imp on impd; it cannot be combined with the other two            |

`imp mcp` with no guard exits 2. A prefix must start a valid imp name and be at most 23 characters,
so a generated name fits in 31.

The guard stops mistakes, such as an agent that destroys the wrong imp. It is not a security
boundary: an agent that can read `~/.config/imp/config.json` or `IMP_TOKEN` can call impd without
the server. The boundary is the token's scope, which impd enforces. Run `imp mcp` with a
[scoped token](./tokens.md#mcp), such as `manage` on `agent-*`, to limit what the agent can do.

## Tools

| Tool                    | What it does                                                        | Hints       |
| ----------------------- | ------------------------------------------------------------------- | ----------- |
| `imp_list`              | the imps inside the guard, with their state                         | read-only   |
| `imp_create`            | create and boot an imp (name, image, vcpus, memoryMib, httpPort)    |             |
| `imp_destroy`           | delete an imp, its disk and its checkpoints                         | destructive |
| `imp_sleep`             | put an imp to sleep; the next use wakes it                          | idempotent  |
| `imp_url`               | the imp's local and tailnet URLs                                    | read-only   |
| `imp_fork`              | a new imp from another's disk, now or at a checkpoint               |             |
| `imp_image_list`        | the images `imp_create` can boot                                    | read-only   |
| `imp_exec`              | run a command to its exit, with capped output and a timeout         | destructive |
| `imp_read_file`         | read a file, as UTF-8 or base64, up to `maxBytes`                   | read-only   |
| `imp_write_file`        | replace a file whole, through a temp file and a rename              | destructive |
| `imp_checkpoint`        | save the imp's disk, with an optional label                         |             |
| `imp_checkpoint_list`   | the imp's checkpoints                                               | read-only   |
| `imp_restore`           | put the disk back to a checkpoint; later writes and memory are lost | destructive |
| `imp_checkpoint_delete` | delete one checkpoint                                               | destructive |

Each result carries the data twice: as `structuredContent`, and as the same JSON in a text block. A
failed call (impd's `NOT_FOUND`, a guard refusal, bad arguments) is a result with `isError: true`,
its text led by the code. An unknown tool name is a protocol error (`-32602`).

No tool reads or writes a file on the host. A sleeping imp wakes and a stopped one boots on the
first exec or file call, as for `imp exec`.

## Exec

`imp_exec` takes `command`, run as `/bin/sh -c COMMAND`, or `argv`, run as it is. Give one of the
two. It waits for the exit and returns the exit code (or the signal), stdout and stderr. A non-zero
exit is a normal result, not a tool error.

- **Output.** Each stream keeps at most `maxOutputBytes` (default 64 KiB, at most 256 KiB): the
  first 8 KiB and the last bytes, with a `[... N bytes dropped ...]` marker between. The command is
  read to its end; only the middle is dropped. The cut never splits a UTF-8 character; invalid UTF-8
  becomes U+FFFD.
- **Timeout.** `timeoutSeconds` (default 120, at most 1800) counts from the call, so a wake is
  inside it. At the timeout the command's process group gets SIGTERM, and 2 s later SIGKILL goes to
  whatever is left of the group, and the result has `timedOut: true`. Closing the exec socket alone
  would send only SIGHUP, which `nohup` ignores. While the command itself runs, the exec session
  carries both signals. A command that exits on SIGTERM ends its session, so a second exec runs
  `kill -KILL -PID` for the rest of the group (a `nohup` child that ignores SIGTERM, say).
- **Cancel.** A `notifications/cancelled` for an exec stops the command the same way, and the
  request gets no response. When the client goes away (stdin closes), every exec still running is
  stopped before `imp mcp` exits.
- **Progress.** A call whose request has a `progressToken` gets `notifications/progress` every 15 s,
  so a client can keep a long call alive. A cancel stops them.

For a server, or a job that runs longer than the timeout, start it in the background and return at
once:

```sh
nohup npm test >/tmp/test.log 2>&1 &
```

Then read `/tmp/test.log` with later calls. Such a job is outside the call and the timeout does not
stop it. A process that calls `setsid` leaves the process group, so a stop does not reach it either.

Only exec and the file tools stop on a cancel. A create, fork or restore that impd has started runs
to its end, and its result is sent despite the cancel, so the agent learns the name of what it made.

## Files

`imp_read_file` and `imp_write_file` take an absolute path in the imp. The path goes to the command
as one argument, never into a shell string, so spaces, a leading dash or `$(…)` stay text. Both run
under a 60 s timeout.

- **Read.** `encoding` is `utf8` (default) or `base64`. A file that is not valid UTF-8 fails with a
  hint to read it as base64. A file larger than `maxBytes` (default 256 KiB, at most 1 MiB) fails
  rather than coming back cut; read a part of it with `imp_exec` (`head`, `tail`, `sed -n`).
- **Write.** At most 4 MiB. The parent directories are created. The content goes to a temp file in
  the same directory, which is then renamed over the path, so no reader sees half a file. A file
  that exists keeps its mode; a new one gets 0666 less the umask. A symlink at the path is followed
  (`readlink -f`), so the file it points to is written and the link stays. A directory at the path
  is refused. A write that fails in the guest (a read-only file system, a full disk) is an `isError`
  result with the command's stderr.

The commands (`head`, `mkdir`, `mktemp`, `stat -c`, `mv`) work in coreutils and in BusyBox, so the
file tools work in a minimal image too.

## Protocol

- Versions `2025-11-25`, `2025-06-18` and `2025-03-26`; a client that asks for another gets
  `2025-11-25`. Tools are the only capability.
- One JSON-RPC message per line. Batches (JSON arrays, which `2025-03-26` allows) are not supported:
  a batch is an invalid request.
- stdout carries only JSON-RPC messages; `imp mcp` writes everything else to stderr.
- `initialize` returns `instructions` that name the guard, so the agent knows which imps it has.

The server lives in `packages/mcp` (`@imp/mcp`), transport-free over the SDK client
(`@zgeoff/imp-client`); `imp mcp` connects it to stdio. An HTTP endpoint on impd is a follow-up: a
guard per client there needs scoped tokens.
