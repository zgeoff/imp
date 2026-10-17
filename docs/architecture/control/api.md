# The API

impd's API is one typed contract, `packages/api`, which the daemon implements and every client
calls: the `impz` CLI, the `@impz/client` library on npm, the MCP server and the dashboard. Elysia
serves the HTTP app, and oRPC serves the contract's procedures under `/rpc`. A few routes sit beside
it, because they need a shape a procedure call does not have: two-way streams, an upload, the
dashboard's files, the MCP endpoint, the login, and the routes a move's two hosts speak.
[Auth](./auth.md) covers who may call what.

The contract package splits by role: the contract itself, the schemas its procedures are built from,
the wire protocols of the routes beside it, and the rules that impd and its clients both apply, such
as how scopes nest and which imps a pattern allows. A client derives its types from those schemas
rather than writing them again.

## Procedures

A control call, such as a create, a checkpoint or a token change, is an oRPC procedure. The contract
carries each procedure's input and output schemas and its typed errors, so the client's types and
the daemon's handlers come from one source, and an error a client switches on, such as `LEASED`,
`MOVING` or `RAM_BUDGET_EXCEEDED`, is part of the contract. A long call that could outlast a
client's fetch timeout, such as an image add or a build, has a streamed twin that yields progress
events. Procedures take POST only, because a GET is what a link or an image on any page can make a
browser send.

A client finds out what an impd can do from `system.features`, which returns impd's version and
feature flags and reads nothing else. `system.info` returns the same flags inside a full status
report, which measures the memory of every awake VM, so a client that only checks a feature calls
`system.features`. An impd older than `system.features` answers it with `NOT_FOUND`, and the client
then reads the flags from `system.info`.

The router checks the caller's access before it validates the input or runs the handler, and a
procedure missing from the access map is refused ([auth](./auth.md#scopes)). Handlers that list
filter by the caller's imps.

## Exec and tunnels

A command, a shell or a session needs a stream both ways, so it is a WebSocket rather than a
procedure. Each exec WebSocket becomes one exec stream to the agent
([the agent protocol](../guest/protocol.md)): impd forwards stdin, resizes and signals to the guest,
and output and the exit back. When too many bytes wait for the client, impd stops reading from the
agent, so a slow client slows the guest's process instead of growing impd's memory. If the socket
still drops a message, impd closes it rather than skip bytes, and a session client resumes from the
offset it has ([sessions](../guest/sessions.md#generations-boots-and-offsets)). A client that
vanished without a close is found by ping and let go.

A file copy runs a tool of the system drive in the guest as root, with acknowledged windows both
ways, so a large upload to a slow guest disk, or a large download to a slow client disk, grows
nobody's memory. A tool runs as root in the guest, so it needs `manage` scope on the imp.

A tunnel WebSocket carries one TCP connection of `impz proxy` or one relay of a reverse forward
([ingress](../network/ingress.md#tunnels-and-reverse-forwards)). Neither end of a WebSocket can
pause its reads, so each side acknowledges the bytes it delivered onward and a sender keeps a
bounded window unacknowledged. A client that sends past the window is closed, so it cannot grow
impd's memory. The close code tells a clean end from a reset, such as a forced sleep, and from impd
stopping.

## Clients

- **The CLI** keeps the hosts it has logged in to, each with its token, and wraps the client
  library. It picks a host from its flags, the environment or the current saved host.
- **The client library** is the oRPC client of the contract, with the WebSocket helpers, for
  browsers, Bun and Node.
- **The MCP server** comes in two forms. `impz mcp` runs locally over stdio with the CLI's client,
  and its guard against mistakes is no security limit. impd's own `/mcp` endpoint is streamable
  HTTP, and runs each tool call through the same procedure handler in process, as the calling
  credential, so the access map and the audit log cover it as they cover the CLI. A public MCP
  route, off by default, serves the same tools behind OAuth ([auth](./auth.md#oauth)).
- **The dashboard** is a React app impd serves under `/ui/`. It holds no token: it calls the API on
  impd's own origin with the session cookie ([auth](./auth.md#the-dashboard-session)), and gets exec
  tickets for its consoles.

## Events, audit and telemetry

The database layer emits each write to an imp or checkpoint row after its commit, with the reason
its caller gives, and no other code writes those rows. A publisher turns the writes into events in
the contract's shape one at a time, so events keep the order of the writes, and puts them on one
in-process bus. The governor puts its decisions there too. The bus feeds the event stream, the
proxy's and the broker's resync when an imp comes or goes, and the telemetry.

The event stream subscribes before it reads its snapshot of the caller's imps, so no write falls in
between, then sends live events filtered to those imps. Delivery is at most once, with no IDs and no
replay, and a reader that falls too far behind is cut off rather than buffered. A client that needs
every change reconnects and takes the new snapshot; the dashboard reconnects and refetches.

The audit log writes one row per call that changes something, refused or not, and per exec, console,
SSH, tunnel and reverse-forward open: the procedure, who called, the imp, the outcome and the time,
never the input. The table is bounded, and its oldest rows go. The broker keeps an audit of its own,
of each request it sent with a credential and each it refused.

Telemetry is OpenTelemetry, loaded only when the owner names an OTLP endpoint. It exports lifecycle
transition counts and durations, governor decisions, RAM, disk, CPU and network use, and spans for
each boot, wake, sleep and restore with a child span per step, all read from the bus and the
resource sampler. Metric attributes stay in a closed set, so no imp name multiplies their series.

impd writes its log through LogTape to stdout, which the container runtime collects. Each line
starts with its level and its category, `impd` plus the area that wrote it, and carries `imp=<name>`
when it concerns one imp. An operation under an imp's lifecycle lock tags every line it writes with
that imp, awaited work included, because the lock runs it inside a log context. Call sites that pass
one line of text in the form `impd: <area or imp>: …` go through an adapter, which reads the area,
the imp and the level from that text and keeps the text unchanged, because scripts and tests match
it.
