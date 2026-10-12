# Backups

impd backs up each imp's disk, its checkpoints and the images they come from to a
[restic](https://restic.net) repository off the host: an S3 bucket, a REST server, or anything else
restic speaks. Backups are off until `IMP_BACKUP_REPOSITORY` is set
([configuration](./configuration.md#backups)). [Backups](../architecture/storage/backups.md) in the
architecture docs covers what a run does.

- `imp backup run` backs up now; the schedule does the same every `IMP_BACKUP_INTERVAL_S`.
- `imp backup ls` lists the restore points, oldest first, with the last prune and check.
- `imp backup restore <name> [--as <new>] [--at <time>]` brings one imp back, stopped.
- `imp backup restore --all [--merge]` brings back every imp the backup holds: a whole host.
- `imp backup check [--subset 5%]` reads part of the repository back and verifies it.

`imp new --no-backup` creates an imp that no backup ever holds: neither its disk nor its checkpoints
reach the repository, for the imp's life. Use it for an imp whose disk holds text you must be able
to delete for good, such as an agent's transcripts. A fork of it is left out too, and a template of
it is refused. `imp backup run` lists it as not backed up, and a restore of it fails with the reason
([imps left out](../architecture/storage/backups.md#imps-left-out)).

`IMP_BACKUP_DATABASE=true` puts impd's database in each backup too, so a whole-host restore brings
back the named tokens, the SSH keys bound to them, the grants and the names of the secrets. It is
off by default. restic encrypts the copy, which holds each token's hash but no token's secret and no
secret's value ([the database copy](../architecture/storage/backups.md#the-database-copy)).

**Create the bucket first.** restic does not exit when the bucket is missing: it retries for
minutes, and the first run then fails.

## Restore

```sh
imp backup restore web                         # the newest point that holds web
imp backup restore web --as web-old --at 2026-10-02T06:00Z
imp backup restore --all                       # a fresh host
imp backup restore --all --merge               # add every imp to a host that has some
```

- `--at` picks the newest restore point at or before the time. **The time is UTC.** A time without a
  zone, such as `2026-10-02T06:00`, is read as UTC, not as the local time of the machine that runs
  the CLI.
- A restored imp is **stopped**, with a new id, slot and address. `imp start` boots it.
- A name in use stops the restore with a conflict that names the imp; `--as` picks another name.
- `--all` refuses a host that has imps, unless `--merge`. With `--merge`, every name is checked
  first, and a clash names the imp; nothing is restored then.
- Each grant comes back when a secret of that name exists on this host. The rest are listed, and
  `imp backup restore` prints them. Secret values are never in a backup: add the secrets first, with
  `imp secret add`, or restore every imp from a backup with the database copy, which brings the
  secrets back without their values.

## Whole-host restore

1. **Stop the old impd, or remove its `IMP_BACKUP_*` settings, first.** Both hosts are named
   `imp-host`, so each one's `restic unlock` would take the other's live locks for its own dead ones
   and drop them. `imp backup restore --all` prints this warning too.
2. Install impz on the new host as usual ([install](./install.md)), with the same `IMP_BACKUP_*`
   settings, the repository's keys and the same password file.
3. Start it. It makes a new root token, as any new host does; the old root token is not in the
   backup.
4. Without `IMP_BACKUP_DATABASE` on the old host, add the connector secrets the imps need
   (`imp secret add`); their grants come back by name. With it, skip this step: a secret you add
   first gets a new generation, which the restored tokens' grantable lists do not name.
5. Run `imp backup restore --all`, with `--at` for an older point. From a backup with the database
   copy, it also brings back each named token with its SSH keys, and each secret without its value,
   and prints their names. A token's own secret works again; a token whose name the host has stays
   as it is, and the restore lists it.

   **CAUTION:** a token deleted after the backup point comes back with it, and its secret works
   again. Delete each such token once more with `imp token rm`.

6. With the database copy, give each restored secret its value with
   `imp secret add <name> ... --replace`, with the kind and rules it had. A replace with the same
   rules is a rotation ([rotate or rebind](./connectors.md#rotate-or-rebind)), so its grants and the
   tokens that may grant it keep working.
7. Start the imps you need. Sleeping imps come back stopped: memory snapshots are not backed up.

A restore of every imp leaves out the OAuth clients that sign in to impd's MCP endpoint: each one
signs in again.

## Security

**CAUTION:** the host holds the repository password. Anyone with the password and read access to the
repository can read every imp's disk. Keep the password file mode 0600, owned by root, and keep a
copy elsewhere: without it, no backup can be restored.

- **The database copy holds every token's hash.** With `IMP_BACKUP_DATABASE=true`, the repository
  holds the audit logs and each token's hash, scope and imps. A hash cannot sign in, but treat the
  repository as you treat the host's data directory.
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

restic takes a lock in the repository for every command, and impd drops its own stale ones before
each run, restore, prune and check. A live lock is never removed: every restic command impd runs
waits a while for another process's lock, such as your own restic, and `imp backup ls` reads without
a lock, so it never waits behind a prune. The host container has a fixed host name, so a restarted
container recognizes its own locks; with a changing name, such a lock blocks prune and check until
restic counts it stale.
