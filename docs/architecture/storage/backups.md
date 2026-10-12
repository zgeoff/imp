# Backups

impd backs up each imp's disk, its checkpoints and the images they come from to a
[restic](https://restic.net) repository off the host: an S3 bucket, a REST server, or anything else
restic speaks. Backups are off until the owner names a repository, and the
[backups guide](../../guides/backups.md) covers running, restoring and protecting them.

restic does the work that a store of impd's own would need: encryption, content-defined
deduplication, many targets, locks, retention, garbage collection and verification. It also gives
one path for both storage backends, because impd only has to show restic a consistent copy of each
disk. impd passes restic only the environment it needs, so no other secret of impd's reaches it, and
the repository password stays in its file, never in an argv, a log or the API.

## What a backup holds

Each run is one restic snapshot of a backup tree in the data directory: a manifest, each imp's disk
and checkpoints, and each image. The paths are the same every run, so restic finds each file it read
the run before and uploads only the chunks that changed.

The manifest is everything a restore reads: each imp's settings, its egress policy, the names of the
secrets granted to it and of the networks it is on, its checkpoints in order, and each image with
its source. It holds no tokens or secret values, and no slots or addresses, since a restore takes
new ones. The database itself stays on the host: each run copies it with `VACUUM INTO`, one
consistent read, and backs up only what that copy names. The copy stays out of the snapshot, so a
table added later never reaches a backup by accident. The root token, the connector secrets, the
broker's CA, the TLS account and the restic password never reach a backup, and a test lists a
snapshot to check it.

## Imps left out

An imp created with backup off never reaches a backup, so a cache that holds personal text, such as
an agent's transcripts, can be deleted for good on the host alone. The setting is fixed at create,
because an imp that a backup already holds would leave copies that turning backups off cannot reach.
A run never locks or copies such an imp. The manifest lists it by name with the reason, and the
snapshot carries an `excluded=<name>` tag, so a restore of the name finds that point and refuses
with the reason instead of a bare not-found. A whole-host restore reports each such imp as not
restorable.

The copies an imp's disk can make keep the setting. A fork is created with backup off too, and a
move carries the setting, so a target too old to keep it refuses the move before any byte goes. A
template of such an imp is refused, because every run backs up every image.

## A run

1. impd drops stale restic locks and copies the database.
2. For each imp, under its lock and only for this step: a running imp's guest is frozen around a
   copy of its disk; a stopped, sleeping or failed imp is copied as it is; a creating imp is left
   out, and an imp created with backup off is never locked or copied. A sleeping imp is not woken to
   sync, because its disk is as after a power cut, which ext4's journal handles, and the guest's
   writes are already in the host's page cache, which a clone sees. The manifest marks which copies
   were synced.
3. The storage backend lays out the tree. On XFS it is reflink clones, and a disk that did not
   change keeps last run's clone, so restic skips it unread. On ZFS it is read-only clones of
   snapshots, mounted at the tree's paths, whose files keep their inodes and times from run to run
   for the same reason. A disk restic does read costs CPU for its whole size, because restic reads
   every hole of a sparse disk as zeros.
4. restic reads the tree with no imp lock held, so imps start, stop, sleep and get destroyed while
   it reads. A destroy retires its disk as usual, and the reclaim waits for the run's clones.
5. restic applies the retention, and the tree closes.

One run, restore, prune or check runs at a time. A scheduled run waits for its interval, checked on
a short tick so a restart never puts a run off by a whole interval. A failed run backs off, so a
full bucket does not freeze every running guest every few minutes. Prunes and checks run on their
own schedules, and a failed check marks the repository as possibly damaged until a check passes.

A crash mid-run leaves no restic snapshot, since restic commits a snapshot only at its end. ZFS
clones and snapshots from the run go at the next start, and the next run's unlock drops the run's
stale lock. A host's restic locks are recognised as its own by a fixed host name, so a restarted
container can drop the locks its crashed restic left; a live lock is never removed.

## Restore

A restore brings one imp back stopped, with a new ID, slot and address, or every imp at once onto a
new host. Its checkpoints come back oldest first: each is written over the disk, writing only the
blocks that changed, and checkpointed in turn, so the checkpoints share blocks as they did. The disk
arrives as a plain sparse file either way, so a backup from an XFS host restores onto ZFS and back.
restic fetches one file at a time, so a restore needs room for one disk, not one per checkpoint.

An image with the same digest is reused, and otherwise restored first. The egress policy comes back
as it was, or as `none` when this impd cannot read it, never more open. Grants come back only for
secrets this host has by name. A restore that fails while impd runs removes the imp it was making;
one cut short by a crash leaves that imp in `error` after the next start, as any create a crash cut
short, and a destroy removes it. Memory snapshots are not backed up, so a sleeping imp comes back
stopped.
