# More than one host

Each imp host runs its own impd, with its own imps, tokens and secrets. The CLI saves each host
(`imp login`, `imp host ls`) and calls one at a time: the current host, or the one `--host` names.
`imp move` takes an imp from one host to another over the tailnet: a stopped one cold, a sleeping
one with its memory. [Moves](../architecture/moves.md) covers the stream and the tickets.

## Moves

```sh
imp move dev big-box            # dev, stopped, from the current host to the saved host big-box
imp move dev big-box            # dev, sleeping: with its memory, when big-box can load it
imp move dev big-box --stop     # stop it first if it runs or sleeps: a cold move
imp --host small move dev big-box   # from a host other than the current one
```

The CLI needs a saved host on both sides: a `manage` token for the imp on the source, and a `manage`
token with no imp patterns on the target, since a receive takes in an image and grants. A move goes
in four steps:

1. The source marks the imp `sending` and counts its data.
2. The target checks that it has no imp by that name and room for twice the data, then issues a
   ticket.
3. The source streams the image (when the target lacks it), each checkpoint and the disk. The target
   writes them to an imp of the same ID, marked `receiving`, and answers with a signed receipt of
   every file's sha256.
4. The source checks the receipt and marks the imp `moved`. It removes the imp's per-imp tailnet
   name, asks the target to commit, then destroys its own copy.

`imp ls` shows the mark in `--json` as `move`. A marked imp does not start, wake, stop, sleep,
change or go away: each call by name fails fast with `409 MOVING` and `Retry-After: 30`. A request
to its URL gets `503` with `Retry-After: 30`, and an SSH login an error with exit status 255. So
neither host can wake the imp while both hold it. On the source, a move holds no lock on storage for
its length: other imps, backups and `imp gc` go on. On the target, `imp gc` waits for the receive,
as it does for a backup.

### What a move keeps

| Kept                                                    | Not kept                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| The ID and the name                                     | The slot, the guest address and the ports: the target picks  |
| vCPUs, memory, disk size, HTTP port, CPU limit, weight  | The memory: the imp arrives `stopped` and boots cold         |
| A warm move: the memory and the slot                    | A warm move: the source's broker CA (see below)              |
| The disk, with everything in it (services too)          | Open connections and sessions: they end                      |
| Each checkpoint, its label and time (with a new ID)     | Secret values: they never leave a host                       |
| The egress policy                                       | Grants of a secret the target has no secret by that name for |
| Grants, for each secret the target has by the same name | The audit logs and the event history                         |
| A template copy's owed identity reset                   | Public exposure: a public imp does not move                  |

The image goes by digest, as files. A target with the digest uses its own; one without it gets the
image in the stream and files it under a digest of what arrived, never the source's claim: the
source's digest names an OCI config the target cannot check against a built rootfs. When the target
has an image by that name with another digest, the moved image's name gets a `-<8 hex>` suffix. A
[template](./templates.md) stays a template, with the name of the imp it came from.

### Warm moves

A sleeping imp moves with its memory, and wakes on the target where it left off: its processes, its
tmpfs and its page cache stay. The snapshot holds the host it was taken on, so the target must match
it. `imp move` checks on the source, the target checks again at the ticket and at the stream, and a
wake checks the CPU as it does on any host ([moves](../architecture/moves.md#warm-moves)). Otherwise
the move is refused, and the message names each fact that differs; `imp move --stop` moves the imp
cold instead.

| The target must have                                  | Why                                                                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The same Firecracker, snapshot format and host kernel | A snapshot loads only on these.                                                                                                                                |
| The same CPU model and CPUID flags                    | The guest kernel picked its code paths from them. In practice: the same kind of machine.                                                                       |
| The same `IMP_DATA_DIR` and storage backend           | The snapshot opens the disk and the system drive by path.                                                                                                      |
| The same `IMP_SUBNET`, and the imp's slot free        | The guest keeps its address, its gateway and its MAC.                                                                                                          |
| The same `IMP_BROKER_PORT`                            | Running processes keep `HTTPS_PROXY`.                                                                                                                          |
| The same `IMP_DNS`, for an `open` imp                 | An open imp asks those servers itself; a `box` or `none` imp asks the host's resolver.                                                                         |
| A source tap with the slot's MAC                      | The guest knows its gateway by that MAC. A tap made before taps took their slot's MAC keeps a random one until a host restart: move such an imp with `--stop`. |
| No IPv6 address in the imp                            | Its address is in the source's /64. `auto` makes a prefix per host; copy `<data>/net/ipv6-ula` to give two hosts the same one.                                 |

The target's broker CA goes into the guest at its first wake. A process that loaded the source's CA
before the move fails TLS to the broker until it restarts. Open connections end, as at any sleep.

### URLs

| URL                                    | After a move                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `http://<tailnet-host>:<20000 + slot>` | Ends. The imp has a new host and slot: `imp url` on the target. A warm move keeps the slot, so the port stays and only the host changes. |
| `https://<name>.<domain>`              | Ends. It follows the target's domain, when the target has one.                                                                           |
| `https://<name>.<tailnet>.ts.net`      | Comes back: the target takes the per-imp name after the commit.                                                                          |

The source removes the per-imp name before it asks the target to commit, so the two hosts never both
serve it. A failed removal does not stop the commit. The target's pass then finds the service still
the source's and fails the name (`exists and this host does not own it`); the source's next pass
removes it and the target's next takes it, so the name comes back within two passes, at most 20
minutes ([per-imp names](./tailscale.md#what-impd-does)).

### Tickets

A ticket is the target's one-time secret for the one move: it names the imp and its byte count, and
it travels in the `Authorization` header, never the URL. Its lifetime:

| Use            | Good for                                                                                |
| -------------- | --------------------------------------------------------------------------------------- |
| The stream     | Once. It must start within 10 minutes of the ticket; each part within 60 s of the last. |
| The commit     | 24 hours after the receipt. A commit the target made already answers the same.          |
| A fresh ticket | `imp move --resume` asks the target for one; it is good for the commit only.            |

### When a move fails

Before the receipt, nothing changed: the target removes what it wrote, and once it confirms, the
source takes its mark off. `imp move` says so; run it again. A target that does not confirm (it is
down, or the network is) leaves the mark on, with the error in `moves.status`: run
`imp move <name> <host> --abort` once it is back.

The send runs in the source impd, not in the CLI. An `imp move` stopped with Ctrl-C leaves it to
finish by itself: `imp ls --json` shows the mark until it does, and a second `imp move` gets
`MOVING` meanwhile. `imp move --abort` ends it instead.

After the receipt, both hosts hold the imp and neither may wake it, until a commit or an abort:

```sh
imp move dev big-box --resume   # a fresh ticket from big-box, then the commit
imp move dev big-box --abort    # big-box drops its copy, and dev stays here
```

An abort the target answers with its commit finishes the move instead: the target's copy is live, so
the source's goes. A source impd that restarts undoes a send cut short and retries the commit of one
the target verified. A target impd that restarts removes a stream cut short and tickets never used.
A verified copy waits on the target until the source commits or aborts it.

### Limits

- The tailnet only. The source refuses a peer URL that is not a literal tailnet address, and the
  target refuses a peer that the connected socket does not show on the tailnet. The tailnet ACL must
  let `tag:imp` reach `tag:imp` on the API port ([ACL](#the-acl)).
- The imp must be stopped, or sleeping on a host the target matches ([warm moves](#warm-moves)). A
  running imp moves with `--stop`, cold; `imp sleep` first keeps its memory.
- The imp must be tailnet-only. A [public imp](./https.md#public-imps)'s credential and DNS record
  belong to the source's domain, so `imp move` refuses it: run `imp unexpose`, move it, then
  `imp expose` on the target. A marked imp refuses `imp expose` and `imp unexpose` with `MOVING`.
- Between two ZFS hosts the disk goes as `zfs send` streams; any other pair sends files
  ([ZFS](../architecture/moves.md#zfs)). Either way the checkpoints get new IDs on the target.
- Names are unique per host, not across hosts: two hosts can each have a `dev`. A move refuses a
  name the target has, and a per-imp tailnet name on the tailnet is one host's: the second fails
  with `exists and this host does not own it`.

### The ACL

Add the impd API port for imp hosts to reach each other:

```json
{ "action": "accept", "src": ["tag:imp"], "dst": ["tag:imp:7070"] }
```

Guests never reach it: their egress refuses `100.64.0.0/10`. impd reports its peer URL from its
tailnet IP and `IMP_API_PORT`; set `IMP_PEER_URL` when the source reaches it at another address
([configuration](./configuration.md#impd)).
