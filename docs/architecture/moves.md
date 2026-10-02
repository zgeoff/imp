# Moves

A move takes a stopped imp from one impd to another over the tailnet. The
[hosts guide](../guides/hosts.md#moves) covers its use, what it keeps and what the URLs do. This
page covers the protocol: `packages/daemon/src/moves/`.

## The steps

| Step | Call                                                | Host   | What it does                                                                |
| ---- | --------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| 1    | `moves.prepare {name, stop?}`                       | source | Stops the imp when asked, marks it `sending`, counts its data bytes.        |
| 2    | `moves.receive {name, bytes}`                       | target | Checks the name and room for twice the bytes, then issues a ticket.         |
| 3    | `moves.send {name, to, ticket}`                     | source | Starts the send in the background; `moves.status` follows it.               |
| 4    | `POST /move/offer`                                  | target | Says whether it needs the image, by digest.                                 |
| 5    | `POST /move/receive`, one per part, then the finish | target | Reads the stream into a staged imp marked `receiving`; answers the receipt. |
| 6    | `POST /move/commit`                                 | target | Takes the mark off. The source then destroys its copy.                      |

The CLI makes calls 1 to 3 with each host's saved token, so the two impds never share a token. The
`/move/*` routes take no token: the ticket is their only credential, and impd answers them only for
a peer on the tailnet. The peer is the connected socket's address, never a header or a lookup; the
source sends only to a literal tailnet address. `IMP_MOVE_TEST_CIDR` adds one range for the e2e
tests, and only with `IMP_E2E=1`; impd logs a warning at start when it is set.

## The stream

The stream is frames: a type byte, a 4-byte big-endian length, then the payload.

| Type | Name       | Payload                                                                               |
| ---- | ---------- | ------------------------------------------------------------------------------------- |
| 1    | `HEADER`   | JSON: the imp's settings, the grants' secret names, the image, the checkpoints        |
| 2    | `FILE`     | JSON: the file's kind (`image-rootfs`, `image-config`, `checkpoint`, `disk`) and size |
| 3    | `DATA`     | An 8-byte offset, then at most 1 MiB of the file at it                                |
| 4    | `FILE_END` | JSON: the sha256 over every `DATA` payload of the file, in order                      |
| 5    | `END`      | `{}`                                                                                  |

The files go in order: the image's two files (only when the target asked), each checkpoint oldest
first, then the disk. `DATA` frames carry only the blocks `SEEK_DATA` finds, so the holes of a
sparse disk never cross the network. The target writes each file to a sparse temp file under
`<data>/moves`, then over the imp's disk block by block, and takes a checkpoint after each one. So
the checkpoints share every block they shared on the source.

The stream goes in POSTs of at most 256 MiB each (`x-imp-move-part: <n>`), so impd's request body
limit never has to fit a whole disk. The target joins the parts into one stream. An empty POST with
`x-imp-move-finish: 1` waits for the receipt.

The target counts the `DATA` bytes against the ticket's byte count and stops a stream that passes
it. It also checks each `FILE_END` sum, and that a `DATA` frame stays inside its file.

## Tickets

`moves.receive` returns `<id>.<secret>`. The target stores the id and the secret's sha256, never the
secret. The ticket goes in `Authorization: ImpMove <ticket>`; one in the URL is refused.

| Window     | Length                    | Then                                                                     |
| ---------- | ------------------------- | ------------------------------------------------------------------------ |
| The stream | 10 minutes from the issue | `410`. The first part marks the ticket used; a second stream gets `409`. |
| A part     | 60 s from the last        | The stream fails, and the target removes the staged imp.                 |
| The commit | 24 hours from the receipt | `410`. `moves.reissue` gives a new ticket for the commit.                |

The receipt is `{body, mac}`: `body` is the JSON text of the ticket id, the imp's name and ID, and
each file's kind, sha256 and byte count; `mac` is HMAC-SHA256 over that text, keyed with the
ticket's secret. Only the two hosts know the secret, so a receipt that holds came from the target.
The source checks the MAC and every sum against what it sent before it marks the imp `moved`.

## The fence

| Source    | Target               | Who may wake it                               |
| --------- | -------------------- | --------------------------------------------- |
| `sending` | none, or `receiving` | Nobody. An abort takes the source's mark off. |
| `moved`   | `receiving`          | Nobody. A commit or an abort ends it.         |
| gone      | none                 | The target.                                   |

`lock.withImp` refuses every call by name on a marked imp with `MOVING`, so no start, wake, stop,
fork, resize, checkpoint or restore runs. The egress policy and the grants refuse changes too: the
header carries the ones the send read at its start. The move's own steps pass `isMove`. The storage
GC drops only what no imp row names, and the marked imp keeps its row, so a GC during the send keeps
every file the send reads.

The commit is idempotent: a target that committed answers a second commit, and an abort, with
`isCommitted: true`. The source destroys its copy on that answer, whether it comes to the send, to
`--resume` or to `--abort`.

## Recovery

At start, the source undoes a `sending` imp (an abort to the target, then the mark off) and retries
the commit of a `moved` one in the background. The target removes the staged imp of a stream with no
receipt, deletes tickets never used past their window, and clears `<data>/moves`. A staged imp with
a receipt stays until the source commits or aborts it. A committed ticket goes once its commit
window ends.
