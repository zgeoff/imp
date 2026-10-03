# MCP server

`imp mcp` gives a coding agent imps as tools. The agent can create an imp, run a test suite in it,
checkpoint before a risky change, fork to try two fixes, and destroy what it does not need. The
server speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio. It reaches
impd as the rest of the CLI does: the current saved host, `--host`, or `IMP_URL` and `IMP_TOKEN`
([configuration](./configuration.md)).

impd also serves the same tools over HTTP at `/mcp`, for an agent on another machine. See
[HTTP](#http).

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

| Tool                    | What it does                                                                       | Hints       |
| ----------------------- | ---------------------------------------------------------------------------------- | ----------- |
| `imp_list`              | the imps inside the guard, with their state                                        | read-only   |
| `imp_create`            | create and boot an imp (name, image, vcpus, memoryMib, httpPort)                   |             |
| `imp_destroy`           | delete an imp, its disk and its checkpoints                                        | destructive |
| `imp_sleep`             | put an imp to sleep; the next use wakes it                                         | idempotent  |
| `imp_url`               | the imp's local and tailnet URLs                                                   | read-only   |
| `imp_fork`              | a new imp from another's disk, now or at a checkpoint; names grants it did not get |             |
| `imp_image_list`        | the images `imp_create` can boot                                                   | read-only   |
| `imp_exec`              | run a command to its exit, with capped output and a timeout                        | destructive |
| `imp_read_file`         | read a file, as UTF-8 or base64, up to `maxBytes`                                  | read-only   |
| `imp_write_file`        | replace a file whole, through a temp file and a rename                             | destructive |
| `imp_checkpoint`        | save the imp's disk, with an optional label                                        |             |
| `imp_checkpoint_list`   | the imp's checkpoints                                                              | read-only   |
| `imp_restore`           | put the disk back to a checkpoint; later writes and memory are lost                | destructive |
| `imp_checkpoint_delete` | delete one checkpoint                                                              | destructive |

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
  carries both signals. When the command exits on SIGTERM, the imp's agent kills the rest of the
  group (a `nohup` child that ignores SIGTERM, say) at the end of the 2 s, before it reports the
  exit. An imp whose agent predates protocol `0.8.0` cannot, and such a child keeps running; stop
  and start the imp to update its agent ([upgrade](./operations.md#upgrade)).
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
stop it: only a stop of the command that started it does. On an agent at protocol `0.11.0` or later,
that stop also reaches a child that left the process group with `setsid` or a double fork; such a
child gets no SIGTERM, only SIGKILL at the end of the 2 s. It does not reach a process that moved
itself to another cgroup (commands run as root unless the image says otherwise), or the containers
of a `dockerd` started from an exec ([exec cgroups](../architecture/agent.md#exec-cgroups)).

`require: ["broker"]` starts the command only once impd set the credential broker's variables and CA
bundle for this boot; otherwise the call fails with `PRECONDITION_FAILED` and nothing runs
([requiring the broker](./connectors.md#requiring-the-broker)).

`imp_exec` runs only in the imp's container. It has no way to run a command in the imp's agent, as
`imp exec --agent` does ([operations](./operations.md#a-broken-container)), and refuses an `outer`
field. The SDK's exec types leave it out too.

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
(`@zgeoff/imp-client`); `imp mcp` connects it to stdio, and impd connects it to `/mcp`.

## HTTP

impd serves MCP's streamable HTTP transport at `/mcp`, on the API's address. A remote agent needs no
`imp` CLI:

```sh
claude mcp add --transport http imp https://imp.example.com/mcp \
  --header "Authorization: Bearer $(imp token new agent --scope manage --imps 'agent-*')"
```

- **Who calls.** A [scoped token](./tokens.md) as `Authorization: Bearer`, or a
  [tailnet identity](./tokens.md#tailnet-identity) with no token. The dashboard's cookie does not
  count. impd resolves the caller on every POST, and every tool call goes to the API as that caller,
  so the same scope, imp patterns and audit rows apply as for the CLI.
- **Browsers.** A request with `Sec-Fetch-Site` or `Origin` comes from a browser, and impd applies
  the dashboard's rule ([daemon](../architecture/daemon.md#api-and-auth)): `Sec-Fetch-Site` must be
  `same-origin`, or without it `Origin` must name impd's host and port. Any other such request gets
  403 before impd looks at its token. A client that is not a browser sends neither header.
- **Tools by scope.** `tools/list` shows only the tools the caller's scope allows: `read` gets
  `imp_list`, `imp_url`, `imp_image_list` and `imp_checkpoint_list`; `exec` adds `imp_sleep`,
  `imp_exec` and the file tools; `manage` gets them all. impd refuses the rest with `FORBIDDEN`.
- **The guard is the token's patterns.** No `--prefix` here. A create without a name works only for
  a caller with exactly one pattern of the form `prefix*`, and gets `prefix` and 8 more characters.
  Any other caller must name the imp, and gets a `GUARD` error that names its patterns.
- **Sessions.** `initialize` returns an `Mcp-Session-Id`; send it on every later request. A session
  answers only the caller that opened it, and another caller gets 404. `DELETE /mcp` with the id
  ends a session. Each caller has at most 16 sessions and impd 256 in all; the least recently used
  idle session makes room, and when every session is busy, `initialize` gets 429. A session idle for
  an hour ends.
- **Restarts.** Sessions live in impd's memory. After a restart a request with an old id gets 404,
  and the client must `initialize` again, as the spec says.
- **Revocation.** Removing a token ends its sessions and stops their execs as a cancel does; the
  next request with the token gets 401. A change to the tailnet ACL or to `IMP_TAILNET_IDENTITIES`
  applies to a tailnet identity on its next request, which impd resolves again: a new scope takes
  effect, or the request gets 401 once no rule matches. An exec already in flight runs on to its
  end.
- **Responses.** A `tools/call` from a client that accepts `text/event-stream` gets an SSE stream:
  its progress notifications, then the response. impd sends an SSE comment every 5 s, so no idle
  timeout on the way ends a long call. Every other request gets one JSON response. A notification or
  a cancelled call gets 202 with no body. A stream the client drops is no cancel: the call runs to
  its end, and its reply goes nowhere. Send `notifications/cancelled` to stop it.
- **No GET and no resume.** impd sends nothing outside a POST's own response, so `GET /mcp` gets 405
  and `Last-Event-ID` is not supported.

Exec over HTTP runs inside impd: the tool takes an exec ticket as the CLI does, and the `/exec`
session is joined in process, not over a socket.

## Public route

An MCP client that signs in with OAuth, such as a hosted connector, cannot hold an imp token or
reach the tailnet. impd can serve it a second `/mcp` on a public origin, behind a TLS front the
operator runs. The route is off until `IMP_MCP_PUBLIC_URL` is set.

| Path                                                | What it serves                                           |
| --------------------------------------------------- | -------------------------------------------------------- |
| `/mcp`                                              | the same tools and rules as [HTTP](#http)                |
| `/.well-known/oauth-protected-resource/mcp`         | protected resource metadata (RFC 9728), also at the root |
| `/.well-known/oauth-authorization-server`           | authorization server metadata (RFC 8414)                 |
| `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` | the sign-in, the token endpoint, revocation (RFC 7009)   |

Every other path gets the same 404, as does a request whose `Host` is not the origin's. The route
follows the MCP authorization spec of 2026-07-28: PKCE with S256, a resource indicator (RFC 8707)
bound to `<origin>/mcp`, and `iss` on every redirect back (RFC 9207). It has no dynamic registration
and no client ID metadata documents: the operator adds each client.

### Turn it on

1. Set `IMP_MCP_PUBLIC_URL` to the bare origin, such as `https://imp.example.com`. impd serves the
   route as plain HTTP on `IMP_MCP_PUBLIC_PORT` (default 7071)
   ([configuration](./configuration.md#public-mcp-route)).
2. Publish that port on the host's loopback only, beside 7070: `-p 127.0.0.1:7071:7071`. The deploy
   files do not publish it.
3. Point the TLS front at `http://127.0.0.1:7071` for the paths above, and send every other path a
   404, never to 7070. Keep the client's `Host`, and cache nothing.
4. Add the client with its redirect URI. The client ID prints on stdout; the client has no secret.

   ```sh
   imp oauth client add conn --redirect-uri https://client.example/oauth/callback
   ```

5. In the client, give `https://imp.example.com/mcp` and the client ID.

impd takes nothing on the route as an identity but an access token from a grant. It refuses an imp
token, the dashboard's cookie and a tailnet identity, and never reads `X-Forwarded-*`, `Forwarded`,
`CF-Connecting-IP` or `x-imp-peer`. Every request comes through the front, so the limits count per
route, client and grant, never per address. impd logs no code, token or query.

### Sign in

1. The client opens the sign-in page. It names the client, where it returns, the scope it asks for,
   and a code such as `ABCD-EFGH`.
2. Approve the code with a named token, over your usual access to impd. The CLI shows the client,
   its redirect URI and when the sign-in started, then approves it:

   ```sh
   imp oauth approve ABCD-EFGH --scope exec --imps 'agent-*'
   ```

3. Press Continue. The page shows the final scope, imps and redirect URI; press Allow.

Approve only a sign-in you started: anyone can open the page for a client impd knows, and ask you to
approve its code. The code is 8 symbols of 32 (40 bits), lasts 10 minutes, and only a named token
can try one: after 20 codes that match nothing, impd takes one every 3 s.

A grant is never wider than the token that approved it:

- its scope is at most the token's and at most what the client asked for; `--scope` defaults to
  `read`;
- each of its patterns is an imp name or a prefix and a trailing `*`, and equals one of the token's,
  or one of the token's is `p*` and the pattern starts with `p`. `--imps` defaults to the token's;
- it grants no secrets.

impd checks the grant and its token on every request. The root token and a tailnet identity cannot
approve: neither can be removed on its own, so neither could end its grants.

### Tokens and revocation

| Credential    | Lifetime                                                                         |
| ------------- | -------------------------------------------------------------------------------- |
| access token  | 15 minutes                                                                       |
| refresh token | rotates on each use; a 30-day inactivity timeout, not an absolute grant lifetime |
| code          | 10 minutes, once                                                                 |
| sign-in       | 10 minutes; at most 16 wait, and 3 for each client                               |

Tokens are opaque (`impat_…`, `imprt_…`); impd keeps only their SHA-256. A refresh answers with the
scope the grant holds, for the same resource.

A grant ends with `imp oauth grant rm <id>`, `imp token rm` of the token that approved it,
`imp oauth client rm`, the client's own revocation, or a replay. Its sessions end, its running
commands stop as a cancel stops them, its unused exec tickets open nothing, and its next request
gets 401. A replay is a code exchanged again, or a spent refresh token, presented in full by its own
client: a wrong secret, an unknown token or another client's request gets `invalid_grant` and
revokes nothing. Two refreshes of one token at once count as a replay too.

A restart ends the sign-ins in progress and their codes, not the grants.

### Limits

64 open requests; 10 sign-ins in a burst, then one every 6 s; 30 token requests per client, then one
every 2 s; 16 sessions per grant. Past one, impd answers 429 with `Retry-After`. A form is at most
16 KiB, and an idle request ends after 30 s, except on `/mcp`.
