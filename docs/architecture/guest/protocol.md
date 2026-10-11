# The agent protocol

impd talks to each guest agent over vsock. Firecracker exposes the guest's vsock as a unix socket in
the imp's directory, and impd reaches the agent by connecting to it and asking for the agent's port.
The guest's network carries none of it, so a guest firewall, a broken network or an egress policy
never cuts impd off from the agent. The Go side is `agent/internal/proto`, and the host side is the
agent client in impd.

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

The protocol's reference is the code: the frame types and the request and error shapes are in the
`proto` package and the agent client.

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
name, generation and boot ID an agent reports is checked against the form the real agent gives it
before impd uses it, so a guest that runs a forged agent can corrupt nothing on the host but its own
records.
