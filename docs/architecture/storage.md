# Storage and images

imp keeps every disk as a copy-on-write clone. An image becomes an ext4 file once; each imp disk,
checkpoint and fork shares its blocks with the one it came from, so it costs no copy and almost no
time. Two backends do this, behind one interface (`packages/daemon/src/storage/storage-backend.ts`):

- **XFS with reflink** (the default): each disk, checkpoint and fork is a reflink clone of another
  file (a clone of a 32 GiB sparse rootfs takes about 3 ms).
- **ZFS**: each disk is a dataset, a checkpoint is a snapshot and a fork is a clone. ZFS can send a
  disk and its checkpoints to another pool, which XFS cannot ([ZFS](#zfs)).

`IMP_STORAGE_BACKEND` picks one ([configuration](../guides/configuration.md#impd)). impd writes the
backend to `<data>/storage-backend` and refuses to start on a data dir another backend wrote:
nothing moves imps between the two.

## XFS with reflink

- `/var/lib/imp` is an XFS filesystem with reflink. On a dev box it is a sparse loop file; on bare
  metal it can be a real XFS partition. `host/scripts/setup-storage.sh` sets it up when the host
  container starts ([configuration](../guides/configuration.md#host-container)).
- The WSL 6.6 kernel needs `mkfs.xfs -m reflink=1 -i nrext64=0,exchange=0 -n parent=0`. Newer
  xfsprogs defaults do not mount on that kernel.
- A clone fails instead of falling back to a full copy.

## The data directory

On XFS:

```text
/var/lib/imp/
  token
  db/imp.sqlite
  system/vmlinux  system/drives/<sha256>.squashfs
  images/<digest>/rootfs.ext4  images/<digest>/config.json
  imps/<id>/disk.ext4  imps/<id>/vm.json
  imps/<id>/run/{api.sock,vsock.sock,firecracker.log,pid}
  imps/<id>/snapshot/{vmstate,mem,meta.json}
  imps/<id>/checkpoints/<cid>/disk.ext4
  tailscale/
  tls/{account.key,account.json,certificate.pem,attempts.json}
```

`tls/` holds the ACME account and the certificate for `IMP_DOMAIN`
([HTTPS](../guides/https.md#files)). `snapshot/` holds the memory of a sleeping imp, and `vm.json`
what its VM booted with ([sleep and wake](./sleep-and-wake.md#snapshot-identity)). [ZFS](#datasets)
keeps the disk and the memory snapshot in other places.

## System files

impd copies the guest kernel and the system drive into `system/` on start.

- **Kernel.** A changed kernel is written next to the old one and renamed over it, so a running VM
  keeps the old inode. Only a cold boot reads it: a snapshot holds the kernel in memory.
- **System drive.** Each drive goes to `system/drives/<sha256>.squashfs` and is never written over.
  A snapshot reopens the drive by the path the VM booted with, and the guest's page cache holds
  blocks of those bytes, so the bytes at that path must stay. After an agent change the old drive
  stays, and a sleeping imp still wakes with its memory and its old agent.
- **Pruning.** On start, after it re-adopts the VMs, impd deletes every drive that is not the
  current one and that no snapshot and no live VM names. An imp leaves an old drive behind once it
  boots cold, or is stopped or destroyed, and the next start removes it. Drives are matched by file
  name, so a moved data dir keeps them. impd never touches the old `system/imp-system.squashfs`
  ([operations](../guides/operations.md#upgrade)).

## Checkpoints, restores and forks

These are the same on both backends; only the clone differs.

- **Checkpoint.** The agent runs `sync` and `FIFREEZE` on `/`, impd clones the imp disk (a reflink
  clone, or a ZFS snapshot), and the agent thaws. The freeze carries a 10 s timeout, so the agent
  thaws by itself if impd never sends thaw. A sleeping imp wakes first, because its memory holds
  page cache that is not on the disk yet. A stopped imp needs no freeze.
- **Restore.** impd clones the checkpoint, stops the VM, drops any memory snapshot, puts the clone
  in place of the disk, and boots again if the imp was awake. A clone that fails leaves the imp as
  it was. Memory and disk always belong together: a snapshot never wakes on a different disk.
- **Fork.** impd clones a disk, or a checkpoint, into a new imp. A fork is disk only. A memory fork
  would duplicate entropy and IDs across the clones.

## ZFS

### Datasets

`IMP_ZFS_ROOT` (for example `tank/imp`) is mounted on the data dir. Every dataset has
`mountpoint=legacy`: the host never mounts them, and impd mounts each one inside the host container.
On start, impd mounts them all again, before it re-adopts or wakes a VM. impd creates what is
missing under the root:

| Dataset                  | Mounted on         | Holds                                                            |
| ------------------------ | ------------------ | ---------------------------------------------------------------- |
| `<root>`                 | `/var/lib/imp`     | the database, system files, `vm.json`, run sockets               |
| `<root>/mem`             | `/var/lib/imp/mem` | `mem/<id>/{vmstate,mem,meta.json}`: memory snapshots             |
| `<root>/images/<digest>` | `images/<digest>`  | `rootfs.ext4`, `config.json`, and the snapshot `@base`           |
| `<root>/disks/<id>`      | `imps/<id>/disk`   | `rootfs.ext4`: a clone of an image's `@base`, or of a checkpoint |
| `<root>/retired/<uuid>`  | not mounted        | old disks and images that checkpoints or clones still need       |
| `<root>/staging/…`       | while a build runs | an image being built, a restore between its clone and its swap   |
| `<root>/reserve`         | not mounted        | nothing; `refreservation=1G` (see below)                         |

- The disk file keeps the image's name, `rootfs.ext4`, since a disk is a clone of the image dataset.
- `disks`, `images` and `staging` get `recordsize=16K`: the guest writes 4 KiB blocks, and a 128 KiB
  record would make each write read and rewrite 128 KiB. The root has `compression=lz4`, `atime=off`
  and `xattr=sa`.
- Memory files live in their own dataset, so a checkpoint never holds a stale 500 MiB memory file.
  `fallocate --dig-holes` works on ZFS too, and lz4 stores zero blocks as holes anyway.
  `primarycache=metadata` on `<root>/mem` is worth measuring on a host; it is not set.
- The host container needs `/dev/zfs`: load the module on the host before the container starts. The
  container has its own zfs userland, OpenZFS 2.3 from Debian trixie ([versions](#versions)).
- `<root>/reserve` holds 1 GiB back, so a destroy still runs on a full pool. To get out of a full
  pool, run `zfs set refreservation=none <root>/reserve`, destroy imps or checkpoints, then set it
  back.

### Versions

impd compares the container's zfs userland with the host's module (`/sys/module/zfs/version`). A
different major version stops impd; a different minor version logs a warning that names both, and
impd starts. The image ships 2.3; Ubuntu 24.04 hosts and the CI runner run 2.2.

The `zfs` CI job runs the image's 2.3.9 tools against the runner's 2.2.2 module. A pass covers only
the commands its suites run (lifecycle, checkpoints, sleep, and the real-pool tests); it does not
prove that 2.3 tools work with a 2.2 module in general.

The backend uses only what OpenZFS 0.8 had already, so every 2.x module works:

| What impd uses                                                    | In OpenZFS since |
| ----------------------------------------------------------------- | ---------------- |
| `zfs create`, `snapshot`, `clone`, `rename`, `promote`, `destroy` | the start        |
| `zfs destroy -d` and the `defer_destroy` property                 | 0.6              |
| `zfs list -Hp`, sorted by `createtxg`; `zfs get -Hp`              | 0.6              |
| the `written` property, `refreservation`, `recordsize=16K`        | 0.6              |
| `compression=lz4`, `xattr=sa`, `atime=off`                        | 0.6              |
| `mountpoint=legacy` and `mount -t zfs`                            | the start        |
| `zfs version`                                                     | 0.8              |
| hole punching (`fallocate --dig-holes` on memory files)           | 0.8              |

A new feature (block cloning, say, from 2.2) needs a check of the module's version first.

### Operations

Dataset changes run one at a time inside impd. A checkpoint and a fork of a live disk have a lane of
their own: the guest is frozen while they run, so they never wait behind a reclaim or another imp's
restore.

- **Checkpoint**: `zfs snapshot <root>/disks/<id>@<checkpoint id>`. Its size is the snapshot's
  `written`: what changed since the previous snapshot. On XFS the size is the clone's allocated
  bytes, which counts shared blocks. Checkpoint ids are global, so impd finds a checkpoint's
  snapshot by its name after `@` wherever it is, and refuses an id that matches none or more than
  one snapshot. An id that a deleted checkpoint's snapshot still holds, because a fork needs it, is
  taken: impd picks another.
- **Fork**: of a checkpoint, `zfs clone` of its snapshot; of a live disk, a `@fork-<uuid>` snapshot,
  a clone, and `zfs destroy -d` of the snapshot. `-d` marks it: ZFS destroys it with its last clone.
- **Restore**: `zfs clone` of the checkpoint to `<root>/staging/restore-<id>`, then, once the VM is
  stopped: unmount the disk, rename it to `<root>/retired/<uuid>`, rename the clone to
  `<root>/disks/<id>`, mount it. Nothing is rolled back, so every other checkpoint, older or newer,
  stays. The old disk keeps them as snapshots until they go.
- **Delete a checkpoint**: the row goes first, then `zfs destroy -d` of the snapshot.
- **Destroy an imp**: `zfs destroy -d` of each of its checkpoints, then the disk is retired.
- **Remove an image**: `zfs destroy -d` of `@base`, then the image is retired.

### Reclaim

A retired dataset stays while one of its snapshots is a live checkpoint. Once every snapshot on it
is marked, impd promotes the clone of its newest snapshot. `zfs promote` hands that clone the
retired dataset's snapshots, and the retired dataset is left as a clone with none, so it can be
destroyed. Its last marked snapshot then goes with it. This is how a fork outlives its source, and
how a removed image hands its blocks to the imps cloned from it. impd reclaims in the background
after every delete, destroy and restore, one promote or destroy at a time, and before anything else
on start. It never promotes a clone in `staging/`: a restore or a backup run destroys it soon, and a
promote would take the retired dataset's snapshots with it.

### Crash recovery

On start, impd settles what a crash cut short, then drops what the database does not name:

- A `staging/restore-<id>` with no `disks/<id>` came after the old disk was retired: impd renames it
  into place, and the restore is done. With `disks/<id>` still there, impd destroys it, and the
  restore never happened. The memory snapshot goes before the swap, so neither case pairs it with
  the wrong disk.
- A `staging/image-*` is a build that never finished: impd destroys it and its mount dir.
- A restore whose swap fails while impd runs is repaired the same way at once: the old disk goes
  back when it is still in place, else the clone takes its name.
- A disk or image with no row is retired; a `@cp-*` snapshot with no row and every `@fork-*` and
  `@bk-*` snapshot is marked for destroy.
- A `staging/bk*` clone is a backup run's: impd unmounts it from the backup tree and destroys it.

### Backups

Off-host backups use restic, not `zfs send` ([backups](./backups.md#why-restic-not-zfs-send)). A run
snapshots each disk as `@bk-<run>-<imp>` and mounts read-only clones of it, of each checkpoint and
of each image in `staging/` while restic reads them ([backups](./backups.md#zfs)).

## Images: any OCI image

1. `imp image build <dir> --name <name>` runs `docker build` and tags the result `imp/<name>`.
   `imp image add <ref>` takes an image the host Docker has, and pulls it when it is missing.
2. impd runs `docker create` and `docker export` and unpacks the tar.
3. It writes the OCI config (`Env`, `WorkingDir`, `User`) to `/etc/imp/image.json` in the rootfs.
   The agent uses it as the default environment for exec and services.
4. It writes the tree into a sparse 32 GiB ext4 file with `mkfs.ext4 -d`, at
   `images/<digest>/rootfs.ext4`.

The cache key is the Docker image ID: a rootfs is built once per ID, and two names for the same ID
share one file. When no image exists at all, impd adds `ubuntu:24.04` as `ubuntu`. An imp created
without `--image` uses `IMP_DEFAULT_IMAGE` (default `base`), else `ubuntu`.

The [images guide](../guides/images.md) covers what an image can contain: services, Docker in the
guest, and how to make your own.
