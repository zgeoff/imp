# Stand-ins and booting impd

imp has a tested stand-in for nearly every boundary that impd, its clients and its scripts cross.
Before you write a stand-in, look for one in the `test-utils` folder of the package that owns the
boundary, where the shared naming rule makes the file name say what it impersonates. Each stand-in's
own test shows what it models and what it refuses. The folders are
[the daemon's](../../../../packages/daemon/src/test-utils/),
[the client's](../../../../packages/client/src/test-utils/),
[the CLI's](../../../../packages/cli/src/test-utils/),
[the MCP server's](../../../../packages/mcp/src/test-utils/) and
[the scripts'](../../../../scripts/test-utils/). The end-to-end harness keeps its own in
[`e2e/lib/`](../../../../e2e/lib/).

## Kinds of stand-in

Choose the kind by the boundary that the code under test reaches:

- **The fake VMM** stands in for the VM runner, which starts and drives each Firecracker, under
  every impd test above the VM layer. A test scripts each VM step to succeed, fail, die or hang, and
  it waits for the count of hung calls to rise before it inspects a held call.
- **Guest agent stand-ins** listen on an imp's vsock socket and speak the agent protocol. Pick the
  one whose protocol area the test drives: exec, sessions, attach, services, dial or echo.
- **Command-layer fakes** answer the CLIs that impd spawns, such as `zfs`, `nft`, `ip`, `tailscale`,
  `mount`, `restic` and `docker`. Each one keeps a model of the state behind the CLI and records the
  argv it got, so a test asserts on the resulting state rather than on the argv alone.
- **Real servers on loopback or a unix socket** stand in where MSW cannot reach: a unix socket, a
  `node:http` client, a WebSocket, real TLS verification, or a request from a child process. The
  Docker engine, the Firecracker API, the DNS upstream, SSH, ACME and the broker's upstreams are
  this kind. The Docker engine stand-ins answer a call they do not model with a 500 that lands in a
  list of unexpected calls, and each test that uses one asserts that list empty.
- **MSW handler sets** stand in for remote HTTP APIs that impd calls at their real origins, such as
  Tailscale, Cloudflare and an OAuth token endpoint. A test builds the set fresh and registers it
  per test, so the preload's handler reset drops it.
- **Temporary directories** stand in for `/proc`, `/sys` and the cgroup tree, because their readers
  take a root path from the caller.
- **Timer stand-ins** fire only when the test says so. Use the stub clock for impd's one clock, and
  the matching repeat, delay or ticker stand-in where a component takes its own timer.
- **Version-skew proxies** sit in front of the real impd app and drop or add fields, procedures or
  events, so the client, CLI and MCP tests can check behaviour against an older or a newer impd.
- **Stub binaries on a temporary `PATH`** stand in for the commands that the shell scripts in
  `scripts/` and `deploy/` run. Each stub logs its calls to one file and answers from a script that
  the test gives it.

The three guest memory stand-ins apply an unplug at different times, and each one fits a different
reader. The fake VMM applies it when the request arrives, the memory controller's stand-in shows it
on the next read, and the shrink loop's stand-in unplugs one step per read.

## Booting impd

`createImpd` holds the wiring that production and the tests share. It builds every service and runs
the boot steps in production's order, but it opens no port, so a test reaches the app through its
request handler or listens on a loopback port itself. Its deps take a stand-in for each boundary. A
boundary that a test leaves out gets the host's real implementation, so pass a stand-in for every
boundary that the test would otherwise touch for real.

The `now` dep reaches leases, the RAM governor, memory control, egress, the broker, tokens, OAuth,
the audit log, moves and the API. Some components stay on the wall clock: the tailnet names'
Services API, the template service's timings, the disk usage cache, backups and the builders' engine
wait. The storage gate and the sleep timing take clocks of their own, so a test that controls their
time passes the stub clock to them directly.

Three harnesses sit beside `createImpd`:

- **The governed-imps harness** wires impd's parts without the boot steps into a caller's stack. Use
  it to restart impd over the same database and VMs, to advance its clock, or to hold a lifecycle
  step. It keeps each unexpected RPC failure in a list and writes it to its own log, not to stderr.
- **The move hosts** build two impds on the governed-imps harness, with a hook that sees every
  request the source sends to the target. The fake VMM numbers VMs from 1 on each host, so boot ids
  of the two hosts collide.
- **The CLI's impd host** runs one real impd per saved host, each with its own data dir, database,
  port and root token, for CLI tests that switch between hosts.

The CLI, client and MCP tests boot impd through `createImpd` and drive it with the real client or
the real binary over a loopback port. A protocol fault that impd never sends, such as a cut stream
or a bad frame, goes to a stand-in peer or to the pure function that parses the answer.

## Bun timer and transport facts

These Bun 1.4.2 behaviours decide how a test of a deadline is built:

- An API listener whose idle timeout is set to 1 s ends a request about 4 s after its last byte. It
  ends a request without a body, or a streamed answer that falls silent, and never one that sent a
  body and still waits for its answer.
- A child Bun with `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1` gets a fetch deadline of about 8 s, measured
  from a silent server's hold. Tests of a client's keepalive run the client in such a child.
- A Bun server on a unix socket closes a silent connection after its default idle timeout. A
  stand-in that holds a build silent serves with an idle timeout of 0 behind a type assertion,
  because Bun's types leave the option off unix servers.
- Over a socket, Bun's fetch replaces the Content-Length of a Blob's stream with the Blob's real
  size. A test that sends a declared size uses a stream it builds itself.

## Connectors

impd's broker sends a granted host to a test upstream when `IMP_BROKER_TEST_UPSTREAMS` holds the
path of a routing file, and it keeps certificate verification on against the file's CA. A daemon
test passes the file through the config loader, with a loopback guest subnet so that a loopback
address stands for a guest. The dev instance and the `connectors` suite use the same file, as the
[development runbook](../../../../docs/runbooks/development.md#end-to-end-tests) describes.
