# The agent protocol

impd talks to each guest agent over vsock. Firecracker exposes the guest's vsock as a unix socket in
the imp's directory, and impd reaches the agent by connecting to it and asking for the agent's port.
The guest's network carries none of it, so a guest firewall, a broken network or an egress policy
never cuts impd off from the agent. One protobuf schema, `proto/imp/agent/v1/agent.proto`, defines
every message, and both sides use the types generated from it: the Go side is
`agent/internal/proto`, and the host side is the agent client in impd.

## One request per connection

Each connection carries one request. The host's first frame is the request, the agent answers or
starts a stream, and the connection ends with it. To make another request, impd connects again. So
nothing is multiplexed, a stream's flow control is its own connection's, and one slow stream never
holds back another. The agent gives a new connection a short time to send its request.

Every message is a frame: a type byte, a length, and a payload that is JSON or raw bytes. A frame
has a size cap, and larger data goes as several frames. The kinds of request fall in a few families:

- **Unary requests**, one answer each: `ping` and the activity report, freeze and thaw, the clock
  after a wake, a disk grow, `claim` for a boot template, shutdown, and the service changes.
- **Exec streams**: a process's stdin, resizes and signals one way, its output and exit the other.
  An outer exec and a session start or attach are exec streams too ([sessions](./sessions.md)).
- **Relays**: a dial to an address or a socket in the guest, which then carries raw bytes both ways,
  and the listeners for reverse forwards and SSH agent forwarding, whose clients each arrive as a
  new connection that impd accepts.
- **Readers**: a service's log, which resumes from a cursor, and a tap on a logged session.

## The schema

Each message body is the proto3 JSON form of a message in the schema, under the schema's field
names, so a frame stays readable in a dump. Protobuf covers only the bodies: the frame types, the
length prefix and the size cap stay hand-written in each side's frame codec, and so do the op names
and error codes, which the schema lists in its comments. `bun run gen:proto` lints the schema and
writes the Go types, impd's TypeScript types and the
[protocol reference](../../reference/agent-protocol.md), and CI fails when the committed output
differs from what the schema generates.

Two rules keep the JSON that every agent version sends and reads, so an older agent works with a
newer impd. A 64-bit count, such as a byte offset, a disk size or a time in Unix milliseconds, is a
`double`: proto3 JSON writes an `int64` as a string, which an older agent refuses in a request,
while a `double` stays a JSON number and is exact up to 2^53, the most impd's JavaScript holds
anyway. A field the sender leaves out when it has nothing to say is `optional`, so its presence
carries meaning, such as the kill grace in `STARTED` that tells impd the agent kills a stopped
command's group. The agent writes every other field even at its zero, and impd leaves a zero out,
which an agent reads as zero.

Each side reads past a field it does not know, because a newer peer may send one, and refuses a
field of the wrong type.

## Contract tests

Tests on both sides hold the protocol to JSON fixtures in the agent's `contract` package, so a
change in what one side writes fails a test before it reaches a guest. The agent's Go tests write
one fixture for each message the agent sends, with the agent's own writer, set every field of every
message in at least one of them, and list the frame types, the error codes and the limits impd
copies. impd's tests decode each of those fixtures with the generated types, refusing a field the
schema lacks, write it back to the same JSON, and fail when a field of the schema appears in no
fixture. In the other direction, the fixtures hold one request for each op, the kernel command line,
the image config and the tar tool's arguments as impd builds them. impd's tests check that its
writer gives each request's JSON, and the Go tests check that the agent decodes each one with no
field left over and every field set.

`go test ./internal/contract -run GuestFixtures -write`, run from `agent/`, writes the agent's
fixtures again; a change to impd's side edits its fixtures by hand.

## Flow control

A stream relies on the connection itself. The agent writes output as fast as the connection takes
it, and impd stops reading from an agent connection while too many frames wait for its client, so a
slow client slows the guest's process instead of growing impd's memory. impd then holds the same
rule toward its own clients ([the API](../control/api.md#exec-and-tunnels)).

## What a sleep does to it

A snapshot restore resets the guest's vsock transport: when the VM resumes, the guest closes every
open connection. The agent's listening socket survives, and if accepting fails anyway the agent
listens again with backoff, since returning from its serve loop would end PID 1 and reboot the
guest. On the host side every request in flight fails, and impd connects again after the wake.

What the agent does with a stream whose host side went away depends on the stream. A plain exec's
process group gets SIGHUP, and after a moment the agent stops counting it, so it no longer keeps the
imp awake. A session only loses its viewer and runs on. A log reader resumes from its cursor.

## Versions

The agent reports its protocol version in `ping`, and impd records it with each cold boot. A woken
imp keeps the agent it booted with, so one host can run guests on many agent versions at once. impd
checks a request's feature against the recorded version before it sends the request, and answers
`AGENT_OUTDATED` when the agent is too old; an agent that answers a request with an unknown
operation gets the same answer. An imp moves to a new agent at its next cold boot.

## Trust

The agent authenticates nothing: reaching the vsock socket on the host is the only gate, and only
impd and the imp's own Firecracker can. In the other direction, impd does not trust the guest. Every
name, generation and boot ID an agent reports is checked against the form the real agent gives it,
and every count must be a whole number that JavaScript holds exactly, before impd uses it, so a
guest that runs a forged agent can corrupt nothing on the host but its own records.
