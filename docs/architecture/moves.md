# Moves

A move takes a stopped imp from one impd to another over the tailnet. The
[hosts guide](../guides/hosts.md#moves) covers its use, what it keeps and what the URLs do. This
page covers the protocol: `packages/daemon/src/moves/`.

## Scope

The cold move is what ships: a stopped imp moves, and boots cold on the target. Not yet built:

- A warm move, which would keep the imp's memory across hosts
  ([#86](https://github.com/zgeoff/imp/issues/86)).
- The whole `imp move` flow (tickets, receipt, commit) on a real ZFS pool, and between two impds in
  the end-to-end tests. On real ZFS the CI `zfs` job runs the backend's steps (a ZFS-to-ZFS send of
  a restored imp, an XFS-style receive); the full flow runs on a fake ZFS only
  (`packages/daemon/src/moves/move-service.test.ts`).

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
`moves.receive` and `moves.reissue` need `manage` on the whole host: a receive takes in an image and
grants, which are host-wide. The image goes under the digest of what arrived, and only grants of a
secret the target has by that name are made. The source's fetches never follow a redirect. The audit
log has each `/move/*` request as `move.<step>`, by `tailnet` as `move from <peer>`. The `/move/*`
routes take no token: the ticket is their only credential, and impd answers them only for a peer on
the tailnet. The peer is the connected socket's address, never a header or a lookup; the source
sends only to a literal tailnet address. `IMP_MOVE_TEST_CIDR` adds one range for the e2e tests, and
only with `IMP_E2E=1`; impd logs a warning at start when it is set.

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
first, then the disk. Between two ZFS hosts, `zfs send` streams take the place of the checkpoint and
disk files ([ZFS](#zfs)): `DATA` frames at running offsets. `DATA` frames carry only the blocks
`SEEK_DATA` finds, so the holes of a sparse disk never cross the network. The target writes each
file to a sparse temp file under `<data>/moves`, then over the imp's disk block by block, and takes
a checkpoint after each one. So the checkpoints share every block they shared on the source.

The stream goes in POSTs of at most 256 MiB each (`x-imp-move-part: <n>`), so impd's request body
limit never has to fit a whole disk. The target joins the parts into one stream. An empty POST with
`x-imp-move-finish: 1` waits for the receipt.

The target counts the `DATA` bytes against the ticket's byte count and stops a stream that passes
it. It also checks each `FILE_END` sum, and that a `DATA` frame stays inside its file.

## ZFS

`imp move` reads the target's storage backend from `system.info` and passes it to `moves.prepare`. A
ZFS source with a ZFS target sends `zfs send` streams; every other pair sends files, as above.

### ZFS to files

For an XFS target, the source snapshots the stopped disk as `@mv-<id>`, then mounts a read-only
clone of it and of each checkpoint's snapshot in `staging/`, as a backup run does. The stream reads
the files there. An XFS source to a ZFS target goes as files too: the target writes each over an
empty disk dataset and takes a snapshot after each checkpoint, so they share blocks as on the
source.

### ZFS to ZFS

An imp's snapshots are not in one line: a restore retires the old disk and clones a checkpoint in
its place, so the checkpoints sit on more than one dataset, linked by origins. `zfs send -R` follows
children, not origins, so it cannot carry them. The source takes `@mv-<id>` of the disk, then sends
the imp's checkpoint snapshots and `@mv` in the order ZFS made them (`createtxg`), each:

| When                                                  | Stream                          |
| ----------------------------------------------------- | ------------------------------- |
| An earlier snapshot of the set is on the same dataset | `zfs send -i <that one>`        |
| Else, the dataset's origin is in the set              | `zfs send -i <origin>`: a clone |
| Else                                                  | `zfs send`: full                |

The header carries each stream's checkpoint, dataset number and base, never a dataset name. The
target checks that the plan follows on, then runs `zfs recv -u` for each into
`staging/mvin-<id>-<n>`, with `-o origin=` for a clone. It names each snapshot itself: a new
checkpoint ID that no snapshot in its pool has. Once every stream is in, the dataset that holds
`@mv` becomes `disks/<id>`, the others go to `retired/`, as a restore leaves them, and `@mv` goes. A
failure destroys what staging holds.

The walk never leaves the imp's own snapshots. A forked disk's first stream is full, so no other
imp's data goes along, and the disk shares no blocks with the target's image. The byte count is
`zfs send -nP`'s estimate with 10 % and 64 MiB to spare, since it is an estimate. Each stream is one
file of the frame stream, hashed as it is sent; a sum that does not match fails the stream before
its end, so `zfs recv` never takes it as whole.

## Tickets

`moves.receive` returns `<id>.<secret>`. The target stores the id and the secret's sha256, never the
secret. The ticket goes in `Authorization: ImpMove <ticket>`; one in the URL is ignored, and the
request gets `401`. The source keeps the whole ticket in `move_sends`: it needs the secret again to
check the receipt and, after a restart, to commit or abort.

| Window     | Length                        | Then                                                                                                      |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| The stream | 10 minutes from the issue     | `410`. The first part marks the ticket used; a second stream gets `409`.                                  |
| A part     | 60 s from the end of the last | The stream fails, and the target removes the staged imp. A stream lasts as long as its parts keep coming. |
| The commit | 24 hours from the receipt     | `410`. `moves.reissue` gives a new ticket for the commit.                                                 |

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
`--resume` or to `--abort`. On the target the commit and the abort run under the imp's lock, so they
never cross. The commit takes the mark off and marks the tickets in one transaction; an imp that is
here unmarked counts as committed, and a ticket whose copy is gone never does. An abort removes the
tickets under the lock, so no commit follows it, then the staged imp.

## Recovery

At start, in the background so impd listens at once, the source undoes a `sending` imp (an abort to
the target, then the mark off once the target confirms) and retries the commit of a `moved` one. The
target removes the staged imp of a stream with no receipt, deletes tickets never used past their
window, and clears `<data>/moves`. A staged imp with a receipt stays until the source commits or
aborts it; one with no ticket left, which an abort cut short, goes. A committed ticket goes once its
commit window ends.
