# Backups

impd backs up every imp's disk, its checkpoints and the images they come from to a
[restic](https://restic.net) repository off the host: an S3 bucket, a REST server, or anything else
restic speaks. Backups are off until `IMP_BACKUP_REPOSITORY` is set
([configuration](../guides/configuration.md#backups)).

- `imp backup run` backs up now; the schedule does the same every `IMP_BACKUP_INTERVAL_S`.
- `imp backup ls` lists the restore points, oldest first, with the last prune and check.
- `imp backup restore <name> [--as <new>] [--at <time>]` brings one imp back, stopped.
- `imp backup restore --all [--merge]` brings back every imp: a whole host.
- `imp backup check [--subset 5%]` reads part of the repository back and verifies it.

## Why restic, not zfs send

The first plan for [#12](https://github.com/zgeoff/imp/issues/12) sent ZFS snapshots and kept a
chunk store of its own for XFS. restic replaced both:

- One path for XFS and ZFS. impd only has to show restic a consistent copy of each disk.
- restic brings encryption, content-defined deduplication, S3 and other targets, locks, retention
  (`forget`), garbage collection (`prune`) and verification (`check`). A hand-rolled store would
  need all of them.
- `zfs send` needs a ZFS pool to receive into. impd has no second ZFS host yet; a send and receive
  path is worth an issue once one exists. The ordering it needs (origins before clones, never
  `send -R`) is in git history, in the storage doc before this change.

restic is pinned in `host/Dockerfile` by version and sha256 (0.19.1). impd uses `backup --json`,
`forget`, `prune`, `check --read-data-subset`, `snapshots --json`, `restore --sparse`, `dump`,
`unlock` and `cat config`, all present since restic 0.17.

## What a backup holds

Each run is one restic snapshot of `<data>/backup/tree`, tagged `imp-backup`, `run=<id>` and
`imp=<name>` for each imp in it:

```text
manifest.json
imps/<imp id>/disk/rootfs.ext4                         the disk
imps/<imp id>/checkpoints/<checkpoint id>/rootfs.ext4  each checkpoint
images/<digest>/rootfs.ext4, config.json               each image
```

The paths are the same every run, so restic finds each file it read the run before.

### The manifest

`manifest.json` is everything a restore reads: each imp's name, image digest, vCPUs, memory, HTTP
port, state, egress policy and its allow-list, the names of the secrets granted to it, its
checkpoints oldest first with labels and times, and each image's name, ref and digest. Each disk and
checkpoint has its size (`diskBytes`) and the blocks its file held in the tree (`usedBytes`), which
a restore holds twice in the [disk budget](./storage.md#disk-budget); a manifest from before
`usedBytes` falls back to the size. It holds no tokens or secret values, and no slots or addresses:
a restore takes new ones.

The database itself stays on the host. Each run starts with `VACUUM INTO <data>/backup/db.sqlite`,
one consistent read of the database, and backs up only what that copy names. The copy stays out of
the snapshot so a table added later never reaches a backup by accident. A secret value goes into a
backup only through the manifest, as an explicit field, with a note here; none does today.

These never reach a backup, and a test lists the snapshot to check it: the API token
(`<data>/token`), the connector secret values (`<data>/secrets`), the credential broker's CA key
(`<data>/broker`), the TLS directory with the ACME account key (`<data>/tls`), and the restic
password file. A restored host keeps its own token, CA and certificates.

## A run

1. The first run creates the repository. **Create the bucket first:** restic does not exit when it
   is missing; it retries for minutes, and the run fails then.
2. `restic unlock` drops stale locks (see [Locks](#locks)).
3. `VACUUM INTO` copies the database; the run reads imps, checkpoints and images from the copy.
4. For each imp, under its lock and only for this step:
   - **running:** the agent freezes the guest's filesystems (FIFREEZE, after a sync), impd copies
     the disk, and the agent thaws them. The copy is `synced: true` in the manifest. When the freeze
     fails, the disk is copied anyway, `synced: false`.
   - **stopped:** copied as it is, `synced: true`.
   - **sleeping** or **error:** copied as it is, `synced: false`. Waking a sleeper to sync would
     cost more than the backup is worth: its disk is as after a power cut, which ext4's journal
     handles. Firecracker's drives use the default cache mode (Unsafe), so the guest's writes are in
     the host's page cache, and a reflink clone or ZFS snapshot sees them all.
   - **creating:** left out of this run.
   - An imp removed or replaced since the copy, or whose copy fails, is left out, and the run goes
     on. `imp backup run` lists each one with its reason.
5. The storage backend lays out the tree (below). Checkpoints and images removed since the database
   copy are left out of the tree and the manifest.
6. `restic backup` reads the tree. No imp lock is held: imps start, stop, sleep, checkpoint and get
   destroyed while restic reads.
7. The tree closes, and `restic forget` applies the retention.

One run, restore, prune or check runs at a time. A restore can therefore wait behind a scheduled
run, and each restic command in it can wait up to 2 minutes more for another process's lock
([Locks](#locks)).

### XFS

The tree is real files in `<data>/backup/tree`, reflink clones of the disks:

- A running imp's disk gets a new clone every run. restic sees a new inode and reads the file;
  deduplication keeps the upload to the changed chunks.
- A sleeping, stopped or error imp keeps last run's clone when its disk has the same inode, ctime
  and size (`<data>/backup/copies.json`). restic then skips the file without reading it.
- Checkpoints and images never change, so each is cloned once and stays.

### ZFS

The copy is a snapshot, `disks/<id>@bk-<run>-<id>`. The tree mounts read-only clones of it, of each
checkpoint snapshot and of each image's `@base`, as `staging/bk-*`, `staging/bkc-*` and
`staging/bki-*`, at the tree's paths. A clone's file keeps its inode, mtime and ctime from run to
run, so restic skips a disk that has not changed since the last run, without reading it. A test
against a real pool checks that the three stay the same.

Each disk snapshot is marked for deferred destroy as soon as its clone exists, and the tree's close
destroys the clones, so the snapshots go with them. While the tree is open:

- `imp rm` works: the disk is retired as usual, and the reclaim waits for the clones.
- The reclaim never promotes a clone in `staging/`: it would take the retired dataset's snapshots
  with it.
- A crash leaves clones and snapshots behind; the next start unmounts and destroys them.

The tree is not kept mounted between runs: its mounts would pin snapshots that block a reclaim.

## Schedule, retention and limits

Every 5 minutes impd checks whether `IMP_BACKUP_INTERVAL_S` (6 hours by default) has passed since
the last run, so a restart never puts a run off by a whole interval. A due run is a backup, then:

- `forget` with `IMP_BACKUP_KEEP` (by default 24 hourly, 7 daily and 4 weekly points) after every
  run, manual ones included;
- `prune` once a day, which holds restic's exclusive lock. A prune that meets another process's lock
  tries again on the next 5-minute check, up to 6 prunes in a row (30 minutes, after which restic
  counts a lock left behind as stale), then waits for the next run; one that fails for another
  reason waits for the next run;
- after a failed run, the next try waits 5 minutes, then twice as long after each failure in a row,
  up to the interval, so a full bucket does not freeze every running guest every few minutes;
- `check --read-data-subset=5%` once a week. A failure logs
  `impd: backup: CHECK FAILED, the repository may be damaged`, and `imp backup ls` shows it until a
  check passes.

`forget` and `prune` only touch snapshots tagged `imp-backup`, grouped by restic's host name, which
impd sets to `impd`.

restic runs as `nice -n 19 ionice -c 3`, with `GOMAXPROCS` from `IMP_BACKUP_CPUS` (2) and
`GOMEMLIMIT` from `IMP_BACKUP_MEMORY_MIB` (512). `ionice` has an effect only under the BFQ I/O
scheduler; under `none` or `mq-deadline`, common in VMs and containers, the CPU priority still
applies. There is no MB/s read limit. On the WSL2 dev box, a 20 GiB sparse disk with 1 GiB of data
took 4.8 s for the first backup to a local repository, 3.2 s to read again after a metadata change,
and 0.8 s unchanged (`GOMAXPROCS=2`, `GOMEMLIMIT=256MiB`). A limit would only stretch that time.

restic reads the holes of a sparse file as zeros: an imp disk is 32 GiB however little it holds, so
each disk restic has to read costs about 10 s of low-priority CPU on the dev box. In the e2e drill
(two imps, one checkpoint, one image: 161 GiB apparent, 135 MiB allocated), the first run took 31–45
s and added 150–178 MiB; the next run, with one imp running and one stopped, took 10–14 s and added
15–19 MiB.

## Restore

```sh
imp backup restore web                         # the newest point that holds web
imp backup restore web --as web-old --at 2026-10-02T06:00Z
imp backup restore --all                       # a fresh host
imp backup restore --all --merge               # add every imp to a host that has some
```

- `--at` picks the newest restore point at or before the time, from `restic snapshots --json`. **The
  time is UTC.** A time without a zone, such as `2026-10-02T06:00`, is read as UTC, not as the local
  time of the machine that runs the CLI.
- A restored imp is **stopped**, with a new id, slot and address. `imp start` boots it.
- Its checkpoints come back in order, oldest first, with their labels and times and new ids. Each is
  written over the disk and checkpointed in turn, writing only the blocks that changed, so the
  checkpoints share blocks as before: reflink clones on XFS, snapshots of the new dataset on ZFS.
  The disk is a plain sparse file from restic either way, so a backup from an XFS host restores onto
  ZFS and back. The writes skip holes with `lseek(SEEK_DATA)`, so a 32 GiB disk with little data
  restores in seconds: 3.9–4.1 s in the drill for an imp with one checkpoint. When the scan ends,
  the data it found is checked against the bytes `fstat` says are allocated. More than max(1 MiB,
  0.1 %) unaccounted for means the scan ended early, and every block from there is read. A file
  restic restored showed no gap on XFS or ext4.
- An image with the same digest is reused. Otherwise it is restored too, under its name, or under
  `<name>-<digest prefix>` when another image has that name.
- A name in use stops the restore with a conflict that names the imp; `--as` picks another name.
- `--all` refuses a host that has imps, unless `--merge`. With `--merge`, every name is checked
  first, and a clash names the imp; nothing is restored then.
- restic fetches one file at a time, a checkpoint or the disk, into `<data>/backup/restore`, and
  impd deletes it once written: a restore needs room for one disk, not one per checkpoint.
- The egress policy comes back as it was; one this impd cannot read comes back as `none`, with a log
  line, never more open. Each grant comes back when a secret of that name exists on this host and
  `imp grant` would accept it; the rest are listed, and `imp backup restore` prints them. Secret
  values are never in a backup: add the secrets first, with `imp secret add`.
- A restore that fails part way removes the imp it was making.

### Whole-host restore

1. **Stop the old impd, or remove its `IMP_BACKUP_*` settings, first.** Both hosts are named
   `imp-host`, so each one's `restic unlock` would take the other's live locks for its own dead ones
   and drop them. `imp backup restore --all` prints this warning too.
2. Install imp on the new host as usual ([install](../guides/install.md)), with the same
   `IMP_BACKUP_*` settings, the repository's keys and the same password file.
3. Add the connector secrets the imps need (`imp secret add`); their grants come back by name.
4. Start it. It makes a new API token, as any new host does; the old token is not in the backup.
5. Run `imp backup restore --all`, with `--at` for an older point.
6. Start the imps you need. Sleeping imps come back stopped: memory snapshots are not backed up.

## Security

**CAUTION:** the host holds the repository password. Anyone with the password and read access to the
repository can read every imp's disk. Keep the password file mode 0600, owned by root, and keep a
copy elsewhere: without it, no backup can be restored.

- impd passes restic only `PATH`, `HOME`, `TMPDIR`, `AWS_*`, `B2_*` and its own `RESTIC_*`
  variables. `TAILSCALE_AUTHKEY` and the rest of impd's environment never reach restic. The password
  stays in its file: it is never in an argv, a log line or the API.
- **Prune from one place.** Either impd forgets and prunes (`IMP_BACKUP_FORGET=true`, the default),
  or one other machine does, with impd's set to `false`. Never point two impds at one repository.
- **Protect the bucket from the host.** A host that is taken over can delete its backups with the
  keys it holds. Use S3 Object Lock, or a policy that denies `s3:DeleteObject` to impd's key on
  everything but `locks/` (restic deletes its own lock files). With deletes denied, set
  `IMP_BACKUP_FORGET=false` and run retention from a machine whose key may delete:

  ```sh
  restic forget --tag imp-backup --group-by host \
    --keep-hourly 24 --keep-daily 7 --keep-weekly 4 --prune
  ```

## Locks

restic takes a lock in the repository for every command. A lock is stale, and `restic unlock` drops
it, when its process is gone from the same host name, or after 30 minutes. impd runs `unlock` before
each run, restore, prune and check, so a lock its own crashed restic left never blocks the next one.
The host container has a fixed host name (`imp-host` in `deploy/`, the container name in
`scripts/dev.sh`) so a restarted container recognizes its own locks; with a changing name, such a
lock blocks prune and check for up to 30 minutes.

A live lock is not stale, and impd never removes it. Every restic command impd runs passes
`--retry-lock 2m`, so it waits up to 2 minutes for another process's lock: the user's own restic, or
a second host on a shared repository. `imp backup ls` runs `restic snapshots --no-lock`. It only
reads snapshot files, so it neither waits behind a prune or a check nor makes them fail, and it runs
outside the one-at-a-time rule above.

## Tests

- Unit tests run the backup service against a fake restic over a directory, with the XFS backend,
  and the ZFS backend against the fake zfs: copies, trees, a destroy while restic reads, a crash
  with the tree open, and a failed open.
- The `backups` e2e suite is the restore drill. It runs MinIO, pinned by digest, in the dev
  instance's network, and covers a backup in the middle of guest writes, a restore with its
  checkpoint, `--all` and `--merge`, a point that survived `forget` and `prune`, a restore with a
  stale exclusive lock in the repository, a corrupted pack that `check` catches, and then, with the
  pack put back and the suite's imps removed, `restore --all` and a boot of a restored imp. The zfs
  CI job runs it on a ZFS pool.
