# Moves

A move takes a stopped imp from one impd to another over the tailnet. The
[hosts guide](../guides/hosts.md#moves) covers its use, what it keeps and what the URLs do. This
page covers the protocol: `packages/daemon/src/moves/`.

## Scope

A stopped imp moves cold, and boots cold on the target. A sleeping imp moves warm, with its memory,
between hosts that can load it ([warm moves](#warm-moves)).

Two end-to-end suites run the whole `imp move` flow between two impds on one machine. `moves` puts
the second host on a Docker network and allows it with `IMP_MOVE_TEST_CIDR`: cold and warm moves, an
abort, and an open and a box imp that keep their tmpfs and processes and reach DNS, HTTP and the
broker right after the wake. `moves-tailnet` makes both hosts `tag:imp` nodes, each with its own
`IMP_TAILSCALE_HOSTNAME`: the real peer check and, with `IMP_E2E_TAILNET_NAMES=1`, the handover of a
per-imp tailnet name. The CI `zfs` job runs the whole flow, cold and warm, between two impds on one
real pool, with fake VMs (`packages/daemon/src/storage/zfs/zfs-move-flow.real.test.ts`), and the
moves suite with real VMs between two dev instances, each on a dataset of its own.

Not yet tested, because it needs a second machine: a warm move refused for a real mismatch of CPU,
kernel or Firecracker (one machine has one of each, so only faked facts reach it), clock skew
against the ticket windows, a real WAN link's MTU and bandwidth over a long stream, and two physical
pools.

## The steps

| Step | Call                                                | Host   | What it does                                                                                                                                                                               |
| ---- | --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `moves.prepare {name, stop?, force?}`               | source | Stops the imp when asked, marks it `sending`, counts its data bytes. A stop checks and ends leases as `imps.stop` does ([leases](#leases)).                                                |
| 2    | `moves.receive {name, bytes}`                       | target | Checks the name and room for twice the bytes, then issues a ticket. The stream reserves twice the bytes for files, and the bytes plus the image for ZFS streams, which skip the temp file. |
| 3    | `moves.send {name, to, ticket}`                     | source | Starts the send in the background; `moves.status` follows it.                                                                                                                              |
| 4    | `POST /move/offer`                                  | target | Says whether it needs the image, by digest, and what it keeps (`keepsMaxMemory`, `keepsLeases`).                                                                                           |
| 5    | `POST /move/receive`, one per part, then the finish | target | Reads the stream into a staged imp marked `receiving`; answers the receipt.                                                                                                                |
| 6    | `POST /move/commit`                                 | target | Takes the mark off. The source then destroys its copy.                                                                                                                                     |

The CLI makes calls 1 to 3 with each host's saved token, so the two impds never share a token. The
`moves.receive` and `moves.reissue` need `manage` on the whole host: a receive takes in an image and
grants, which are host-wide. The image goes under the digest of what arrived, and only grants of a
secret the target has by that name are made. The source's fetches never follow a redirect. The audit
log has each `/move/*` request as `move.<step>`, by `tailnet` as `move from <peer>`. The `/move/*`
routes take no token: the ticket is their only credential, and impd answers them only for a peer on
the tailnet. The peer is the connected socket's address, never a header or a lookup; the source
sends only to a literal tailnet address. `IMP_MOVE_TEST_CIDR` adds one private range for the e2e
tests, and only with `IMP_E2E=1`; impd logs a warning at start when it is set. Outside that range,
`IMP_PEER_URL` must name a tailnet address, or impd does not start.

## The stream

The stream is frames: a type byte, a 4-byte big-endian length, then the payload.

| Type | Name       | Payload                                                                                                                                                                                                                                             |
| ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `HEADER`   | JSON: the imp's settings, the grants' secret names, the image, the checkpoints, and the imp's last 4 cold boots, for a cold move and a warm one alike. The settings include an owed identity reset; the image includes its source (`oci` or `imp`). |
| 2    | `FILE`     | JSON: the file's kind (`image-rootfs`, `image-config`, `checkpoint`, `disk`) and size                                                                                                                                                               |
| 3    | `DATA`     | An 8-byte offset, then at most 1 MiB of the file at it                                                                                                                                                                                              |
| 4    | `FILE_END` | JSON: the sha256 over every `DATA` payload of the file, in order                                                                                                                                                                                    |
| 5    | `END`      | `{}`                                                                                                                                                                                                                                                |

The cold boots go with every move ([output offsets](./daemon.md#output-offsets)): a client from
before a cold move finds its own boot among them, and learns that the next boot ended its output.
The target takes at most 4, each with a UUID boot ID and a cause it knows, and clamps a time ahead
of its own clock to now.

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
failure in staging destroys every `staging/mvin-<id>-*`, found by listing, clones first. A failure
after the renames leaves the disk to the staged imp's removal and the retired datasets to the GC.

The walk never leaves the imp's own snapshots. A forked disk's first stream is full, so no other
imp's data goes along, and the disk shares no blocks with the target's image. The byte count is
`zfs send -nP`'s estimate with 10 % and 64 MiB to spare, since it is an estimate. Each stream is one
file of the frame stream, hashed as it is sent. `zfs recv` commits when it reads the stream's end
record, not when its input closes, so the target holds back each stream's last `DATA` frame until
`FILE_END`'s sum matches: a stream whose sum does not match never reaches `zfs recv` whole. On the
source, a send cut short stops `zfs send` and waits for it to exit before `@mv` goes.

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
header carries the ones the send read at its start. The exposure refuses changes, and a public imp
never moves: `prepare` refuses one, and checks again after its mark, so an expose that lands before
the mark undoes it. The move's own steps pass `isMove`. The storage GC drops only what no imp row
names, and the marked imp keeps its row, so a GC during the send keeps every file the send reads.

The commit is idempotent: a target that committed answers a second commit, and an abort, with
`isCommitted: true`. The source destroys its copy on that answer, whether it comes to the send, to
`--resume` or to `--abort`. On the target the commit and the abort run under the imp's lock, so they
never cross. The commit takes the mark off and marks the tickets in one transaction; an imp that is
here unmarked counts as committed, and a ticket whose copy is gone never does. An abort removes the
tickets under the lock, so no commit follows it, then the staged imp.

## Leases

The header's `imp.leases` lists the imp's live leases: `principal`, `label`, `display`, `createdAt`
and `remainingMs`, the time left at the source's now when it built the header, or null for no end.
The target notes its own now when it parses the header and ends each lease `remainingMs` after it,
so clock skew between the hosts has no effect; only the network's latency adds to a lease. The disk
can take long: the target writes the leases after it, beside the cold boots, and leaves out one that
ended meanwhile. The rows belong to the staged imp, so a failed or aborted receive, and a restart
that removes a staged imp, delete them with it. The commit writes nothing more; for an imp with a
live lease it emits `ImpChanged` with reason `held`, as an acquire does.

The header bounds them: at most 1024 leases, `remainingMs` a whole number up to 100 years, a label
by the lease API's rules, and a principal and a display of 1 to 256 characters. The source checks
its own leases against these bounds at the offer, and refuses before the stream; a lease that ends
past 100 years moves with 100 years left, and the source logs it. A source from before moving leases
leaves `leases` out; the target logs that the imp arrives with none.

On the source, `prepare` with `stop` checks `LEASED` before it halts a running or sleeping imp, and
with `force` ends the leases from `leases.*` after its mark is on, under the same lock. A failure
between the halt and the mark keeps the leases and starts a running imp again. The rows stay until
the commit destroys the imp; a failed or aborted send leaves them, less any that `force` ended.

The offer reply's `keepsLeases` says the target writes them. A target from before it leaves it out.
The source then refuses a send of an imp with any live lease, before the stream, and starts again an
imp that its prepare halted, as it does when a target lacks `keepsMaxMemory`.

## Recovery

At start, in the background so impd listens at once, the source undoes a `sending` imp (an abort to
the target, then the mark off once the target confirms) and retries the commit of a `moved` one. The
target removes the staged imp of a stream with no receipt, deletes tickets never used past their
window, and clears `<data>/moves`. A staged imp with a receipt stays until the source commits or
aborts it; one with no ticket left, which an abort cut short, goes. A committed ticket goes once its
commit window ends.

## Warm moves

A warm move (#86) brings a sleeping imp with its memory, into the same slot on the target: the
snapshot holds the slot's tap, addresses and MAC. Each new tap's MAC comes from its slot
([addressing](./networking.md#addressing)), so the guest's neighbour entry for its gateway holds.

**The facts** ([hosts](../guides/hosts.md#warm-moves) lists them) are checked three times.
`moves.prepare` compares the snapshot and the source host with the target's `moves.facts`.
`moves.receive` and the stream's header carry the same claim, and the target checks it against its
own facts. Last, before it writes `meta.json`, the target runs the wake's own check,
`findColdBootReason`, on the record. A wake checks the CPU too, so a snapshot that got past every
check still boots cold, never faults.

**The stream** carries `vmstate` and `mem` after the disk, as files of data blocks, and the system
drive before them when `/move/offer` finds the target lacks it. The header carries `meta.json`,
`vm.json` and, for a `box` imp, the addresses its set lets in, with the seconds each has left.

- The target writes `vmstate` and `mem` straight into the imp's snapshot directory (on ZFS,
  `<data>/mem/<id>`, a directory in the `mem` dataset, so no rename crosses datasets). Without
  `meta.json` they load nothing, and removing the staged imp removes them.
- The drive lands under its sha256, which other snapshots trust: the target hashes what arrived and
  refuses a drive whose sum is not its name. Whether the drive came along or not, `meta.json` and
  `vm.json` must name this host's own path for that sha256.
- The wake on the target is a memory wake into the boot the imp slept in, which the carried cold
  boots name ([the header](#the-stream)), so it records no cold boot. A wake that cannot load the
  memory boots cold with the cause `wake_fallback`.
- The imp's disk grow, if one is pending, goes along: the first wake on the target grows the guest.
- A tap that a failed destroy left in the slot is removed before the staged imp exists, so the wake
  makes it again with the slot's MAC.
- `meta.json` goes last. The commit sets the imp `sleeping` in the transaction that takes the mark
  off, and only when `meta.json` reads whole; else it refuses, and the source keeps its copy.
- `imps.trust_pending` marks the imp until its first wake here, which installs this host's broker CA
  in the guest at once.

**Trust.** A warm move trusts the source with the target host, not only with the imp. `vmstate` is
Firecracker's own format, which the target does not parse: the paths it names (the disk, the system
drive, the vsock socket) are what the target's Firecracker opens at the load. The target checks the
drive path in `meta.json` and `vm.json`, not the paths inside `vmstate`. With the
[jailer](./daemon.md#the-jailer), the load runs in the imp's chroot as its uid, so it opens only
what the jail holds; with `IMP_JAILER=false` it has impd's rights. Run warm moves only between hosts
that trust each other.

**The jail uid.** A moved imp gets a uid of the target's own at the create, as a cold-moved one
does; the source's never goes along. The files arrive as root's. The prepare before the first wake
gives the disk to that uid and the snapshot files to its group, as before any wake.

**The slot.** The ticket keeps the imp's slot (`move_tickets.slot`) until the commit once its stream
started, else until its start window ends. A stream that fails, or ends with no part for 60 s, gives
the slot up at once, abort or not. A reissued ticket keeps it, so `imp move --resume` commits warm.
So an `imp new` on the target during a long stream takes another. The staged imp is created in
exactly that slot, or the receive fails with `slot <n> is taken on this host`.
