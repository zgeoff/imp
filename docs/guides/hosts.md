# More than one host

Each imp host runs its own impd, with its own imps, tokens and secrets. The CLI saves each host
(`imp login`, `imp host ls`) and calls one at a time: the current host, or the one `--host` names.
`imp move` takes a stopped imp from one host to another over the tailnet.
[Moves](../architecture/moves.md) covers the stream and the tickets.

## Moves

```sh
imp move dev big-box            # dev, stopped, from the current host to the saved host big-box
imp move dev big-box --stop     # stop it first if it runs or sleeps
imp --host small move dev big-box   # from a host other than the current one
```

The CLI needs a saved host, with a `manage` token for the imp, on both sides. A move goes in four
steps:

1. The source marks the imp `sending` and counts its data.
2. The target checks that it has no imp by that name and room for twice the data, then issues a
   ticket.
3. The source streams the image (when the target lacks it), each checkpoint and the disk. The target
   writes them to an imp of the same ID, marked `receiving`, and answers with a signed receipt of
   every file's sha256.
4. The source checks the receipt and marks the imp `moved`. It removes the imp's per-imp tailnet
   name, asks the target to commit, then destroys its own copy.

`imp ls` shows the mark in `--json` as `move`. A marked imp does not start, wake, stop, sleep,
change or go away: each call by name fails fast with `409 MOVING` and `Retry-After: 30`. So neither
host can wake the imp while both hold it. On the source, a move holds no lock on storage for its
length: other imps, backups and `imp gc` go on. On the target, `imp gc` waits for the receive, as it
does for a backup.

### What a move keeps

| Kept                                                    | Not kept                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| The ID and the name                                     | The slot, the guest address and the ports: the target picks  |
| vCPUs, memory, disk size, HTTP port, CPU limit, weight  | The memory: the imp arrives `stopped` and boots cold         |
| The disk, with everything in it (services too)          | Open connections and sessions: they end                      |
| Each checkpoint, its label and time (with a new ID)     | Secret values: they never leave a host                       |
| The egress policy                                       | Grants of a secret the target has no secret by that name for |
| Grants, for each secret the target has by the same name | The audit logs and the event history                         |

The image goes by digest, as files. A target with the digest uses its own; one without it gets the
image in the stream. When the target has an image by that name with another digest, the moved
image's name gets a `-<8 hex>` suffix.

### URLs

| URL                                    | After a move                                                    |
| -------------------------------------- | --------------------------------------------------------------- |
| `http://<tailnet-host>:<20000 + slot>` | Ends. The imp has a new host and slot: `imp url` on the target. |
| `https://<name>.<domain>`              | Ends. It follows the target's domain, when the target has one.  |
| `https://<name>.<tailnet>.ts.net`      | Comes back: the target takes the per-imp name after the commit. |

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

Before the receipt, nothing changed: the source takes its mark off and the target removes what it
wrote. `imp move` says so; run it again.

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
- The imp must be stopped. A move with its memory comes later.
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
