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
  ssh/host_key  ssh/authorized_keys
  db/imp.sqlite
  system/vmlinux  system/drives/<sha256>.squashfs
  images/<digest>/rootfs.ext4  images/<digest>/config.json
  imps/<id>/disk.ext4  imps/<id>/vm.json
  imps/<id>/run/{api.sock,vsock.sock,firecracker.log,pid}
  imps/<id>/snapshot/{vmstate,mem,meta.json}
  imps/<id>/watchdog/{vmstate,mem,meta.json}
  imps/<id>/checkpoints/<cid>/disk.ext4
  tailscale/
  tls/{account.json,certificate.pem,attempts.json}
```

`tls/` holds the ACME account and the certificate for `IMP_DOMAIN`
([HTTPS](../guides/https.md#files)). `snapshot/` holds the memory of a sleeping imp; during a wake
its `meta.json` is `meta.json.loading` ([wake](./sleep-and-wake.md#wake)). `vm.json` holds what its
VM booted with ([sleep and wake](./sleep-and-wake.md#snapshot-identity)), and `watchdog/` the memory
the [watchdog](./sleep-and-wake.md#the-watchdog) saved before a restart. [ZFS](#datasets) keeps the
disk and the memory snapshot in other places.

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
- **Template.** impd clones a disk, frozen as for a checkpoint, into a new image
  (`images/imp-<uuidv7>`), and imps are made from it as from any image. The first boot of each one
  gets a new machine-id and new ssh host keys ([templates](../guides/templates.md)).

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
  container has its own zfs userland, OpenZFS 2.4 from Debian trixie-backports
  ([versions](#versions)).
- `<root>/reserve` holds 1 GiB back, so a destroy still runs on a full pool. To get out of a full
  pool, run `zfs set refreservation=none <root>/reserve`, destroy imps or checkpoints, then set it
  back.

### Versions

impd compares the container's zfs userland with the host's module (`/sys/module/zfs/version`). A
different major version stops impd; a different minor version logs a warning that names both, and
impd starts. The image ships 2.4.4 from trixie-backports, pinned through a dated snapshot
(`ZFS_SNAPSHOT` and `ZFS_VERSION` in `host/Dockerfile`), to match Ubuntu 26.04's 2.4 module. Ubuntu
24.04 hosts and the CI runner run 2.2, two minor versions behind: impd warns there and starts. The
pin makes the zfs userland the same on every build, not the whole image: the rest of the runtime
stage comes from the live Debian archive. snapshot.debian.org can be slow, so a cold build of that
layer may take minutes.

The `zfs` CI job runs the image's 2.4.4 tools against the runner's 2.2.2 module. A pass covers only
the commands its suites run (lifecycle, checkpoints, disks, sleep, and the real-pool tests); it does
not prove that 2.4 tools work with a 2.2 module in general.

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

On start, impd settles what a crash cut short, then runs the [cleanup](#cleanup) sweep:

- A `staging/restore-<id>` with no `disks/<id>` came after the old disk was retired: impd renames it
  into place, and the restore is done. With `disks/<id>` still there, impd destroys it, and the
  restore never happened. The memory snapshot goes before the swap, so neither case pairs it with
  the wrong disk.
- A `staging/image-*` is a build that never finished: impd destroys it and its mount dir.
- A restore whose swap fails while impd runs is repaired the same way at once: the old disk goes
  back when it is still in place, else the clone takes its name.
- A `@cp-*` snapshot with no row and every `@fork-*` and `@bk-*` snapshot is marked for destroy,
  unless it sits on an orphan. An image with no unmarked `@base` is retired. A disk or a whole image
  with no row is an orphan, and stays ([what a sweep takes](#what-a-sweep-takes)).
- A `staging/bk*` clone is a backup run's: impd unmounts it from the backup tree and destroys it.

### Backups

Off-host backups use restic, not `zfs send` ([backups](./backups.md#why-restic-not-zfs-send)). A run
snapshots each disk as `@bk-<run>-<imp>` and mounts read-only clones of it, of each checkpoint and
of each image in `staging/` while restic reads them ([backups](./backups.md#zfs)). The clones have
`readonly=on` and mount with `-o ro`: a legacy mount ignores the property.

## Images: any OCI image

1. `imp image build <dir> --name <name>` uploads the directory as a tar and runs `docker build` on
   it; `--on-host` builds a directory on the host instead. Either way the result is `imp/<name>`.
   `imp image add <ref>` takes an image the host Docker has, and pulls it when it is missing.
2. impd runs `docker create` and `docker export` and unpacks the tar.
3. It writes the OCI config (`Env`, `WorkingDir`, `User`) to `/etc/imp/image.json` in the rootfs.
   The agent uses it as the default environment for exec and services.
4. It writes the tree into a sparse ext4 file with `mkfs.ext4 -d`, at `images/<digest>/rootfs.ext4`:
   the tree's size and a fifth more, plus 2 GiB, in whole GiB, and at least 4 GiB. A tree of many
   small files gets twice its count of inodes. Images built before disk sizes keep their 32 GiB
   filesystem.

## Disk sizes

An imp's disk is a file larger than its image's filesystem; the guest grows the filesystem to fill
it. `imp new --disk 64g` sets the size, `IMP_DEFAULT_DISK_GIB` (32) is the default, and the size is
never below the image's filesystem. A fork takes its source's size, and a checkpoint keeps the size
the disk had, which a restore or a fork from it takes back. A backup's manifest holds the sizes.

`imp disk resize <name> <size>` grows the file, never shrinks it: the guest's ext4 cannot shrink
online. Both backends keep the disk as a file (on ZFS, in its dataset), so the grow is a `truncate`
under the imp's lock. The guest follows:

- **Stopped**, and a new disk before its first boot: impd runs `resize2fs` on the host, about 80 ms
  for 4 to 100 GiB. A filesystem that was not unmounted cleanly is skipped, since its journal must
  replay first; the guest grows it instead. Every cold boot also grows the filesystem to fill the
  disk: the agent's stage 1 runs `EXT4_IOC_RESIZE_FS`, an online resize, after it mounts the disk.
- **Running**: impd sends `PATCH /drives/rootfs` so Firecracker reads the file's size again and
  tells the guest, then the agent's `grow` request waits for the new size and resizes
  ([protocol](./protocol.md#grow)).
- **Sleeping**: the snapshot holds the old size, so the grow waits for the wake, which runs the same
  two steps. A failed grow stays pending (`disk_grow_pending`) for the next wake; a cold boot clears
  it.

The guest mounts its root with `noinit_itable`. A grown filesystem has new inode tables, which ext4
zeroes: in the background by default, or at once in an online resize with `noinit_itable`. The disk
is a sparse file, so those tables read as zeros already, and zeroing them only allocates host space:
about 1.6 % of the new size (1.6 GiB for a 4 GiB image grown to 100 GiB). `resize2fs` on the host
leaves them as holes, which is why a stopped disk grows there. An online grow, of a running or
sleeping imp, still pays the 1.6 %. So did every disk made before disk sizes: the guest zeroed the
tables of its 32 GiB filesystem, and each such disk already holds about 0.5 GiB of them.

`mkfs.ext4` keeps `resize_inode`, which lets an online grow add block group descriptors: a 4 GiB
filesystem grows to well past 1 TiB. The journal keeps the size mkfs gave the image, 64 MiB for a 4
GiB filesystem where a 32 GiB one gets 256 MiB. A grown disk with heavy metadata writes may want the
larger journal; `tune2fs` can only change it offline.

The cache key is the Docker image ID: a rootfs is built once per ID, and two names for the same ID
share one file. When no image exists at all, impd adds `ubuntu:24.04` as `ubuntu`. An imp created
without `--image` uses `IMP_DEFAULT_IMAGE` (default `base`), else `ubuntu`.

The [images guide](../guides/images.md) covers what an image can contain: services, Docker in the
guest, and how to make your own.

## Disk usage

`imp ls` shows two numbers for each imp. USED is what a destroy of the imp would free: its disk, its
checkpoints and its memory snapshot. SHARED is what it refers to that others hold too: the image and
the source of a fork. A pass measures every imp at start, every 5 minutes, and 10 s after an imp or
a checkpoint comes or goes; `imp ls` reads the last pass, and `--json` gives its time.

On ZFS, one `zfs list` gives it all. USED is the disk's `used` (with its snapshots), plus each
retired dataset that holds the imp's checkpoints after a restore, plus the memory file. SHARED is
`referenced - usedbydataset`, what the disk took from its origin. When a fork, or a backup tree,
clones one of the imp's snapshots, a destroy frees less than USED, which `imp ls` marks with `<=`.

On XFS, a reflink leaves no count of who holds a block, so impd reads every file's extents with the
FIEMAP ioctl: each imp's disk, checkpoints, memory and vmstate, each image, and `backup/tree`, whose
reflinks hold blocks between backup runs. An extent that only one owner holds is that owner's; one
that two hold is shared. It reads 1024 extents per call and yields between calls, so impd stays
responsive. It never asks the kernel to flush first (`FIEMAP_FLAG_SYNC`), so blocks not yet written
count as their owner's. FIEMAP takes the file's inode lock, so a VM's write to that file waits for
the one call. A pass reads the images and the backup tree first, then the imps, and stops after 20
s. An imp it did not finish keeps its last count, and the next pass starts at that imp; `imp ls`
marks a count from a cut-short pass with `?`, since an imp it never reached could share its blocks.

## Disk budget

Disks are sparse and clones are thin, so the sizes imps are given can add up to more than the host
has; `imp info` shows the total against the filesystem or pool. What protects the host is a reserve
of free space no write may take: `IMP_DISK_RESERVE_GIB`, by default max(5 GiB, 5 % of the filesystem
or pool).

One ledger in impd takes each write's estimate off the free space until the write ends, under a
lock, so two writes never pass on the same reading. A write that would leave less than the reserve
fails with `DISK_FULL` (HTTP 507), before it touches anything:

| Write                                           | Estimate                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| sleep                                           | the imp's memory: the file is full size until its holes are dug                                                         |
| watchdog snapshot                               | the imp's memory, as a sleep                                                                                            |
| image build                                     | twice the Docker image: the tree, and the ext4 file from it                                                             |
| build from an upload                            | its Content-Length (else the upload limit) while the tar arrives, the tar again for Docker's copy, then twice the image |
| restore from backup                             | twice each file's blocks while restic fetches and writes it (an older manifest: the disk size); twice an image's size   |
| create, fork                                    | 0: a thin clone                                                                                                         |
| checkpoint, template, resize, start, backup run | 0: refused only once the reserve is reached                                                                             |

A wake is never refused: its disk and memory exist already, and a full disk must not strand an imp's
work. A sleep that is refused leaves its imp running, as any failed sleep does; the governor turns
to another imp. Below twice the reserve, impd logs a warning and `imp info` marks the storage LOW;
the warning comes once per episode, which ends when free space is a GiB clear of the line.

On ZFS, `available` lags: a write's blocks count only once its transaction group commits, about 5 s
later, and a destroy frees blocks in the background. So the ledger keeps each write's hold for 20 s
after the write ends, and never counts freed space before ZFS reports it.

On XFS in a loop-mounted file, the filesystem inside can report room that the sparse file's host
directory no longer has. Free space is then the smaller of the two, read from the loop device's
backing file.

Both backends hold 1 GiB back besides, so a destroy still runs on a full disk: ZFS's
`<root>/reserve` (above), and on XFS the file `<data>/reserve`, which start allocates with
`fallocate` when twice its size is free. To get out of a full XFS filesystem, remove the file,
destroy imps or checkpoints, and restart impd, which allocates it again.

## Cleanup

A crash, or a removal that failed halfway, can leave storage that no row names: an imp's disk and
directory, a checkpoint, an image, a ZFS fork or backup snapshot, a memory snapshot. One sweep,
`dropUnnamed`, runs on both backends: at start, every hour, and on `imp gc`. It removes what a crash
explains, and keeps the orphans: the disks and images that no row names and no crash explains.
`imp gc --dry-run` lists what would go. On ZFS a disk or image is retired, and the reclaim frees it
once no clone needs its blocks.

### What a sweep takes

A crash between a destroy's row and its disk leaves an orphan, but so does a lost or replaced
database. On ZFS the database lives on the root dataset, on the pool with the disks, so an OS
reinstall keeps both. A database restored from an older copy, or one that is gone while the pool
survives, makes every newer disk an orphan; a sweep that took them would delete every imp. So a
sweep sorts what no row names into two classes:

| What no row names                                                                   | Class          | Why                                                                                 |
| ----------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| A disk (`disks/<id>`, or `imps/<id>` with a disk, checkpoint or memory file on XFS) | orphan: kept   | It may hold an imp; only its row says it does not.                                  |
| An image with its `@base` (ZFS) or its `rootfs.ext4` (XFS)                          | orphan: kept   | It may be the origin of a kept disk, or a template.                                 |
| Any snapshot or checkpoint on an orphan                                             | kept with it   | A snapshot never goes before the disk it belongs to.                                |
| A `@cp-*` snapshot or checkpoint of a named disk, with no row                       | leftover: goes | A checkpoint delete removes the row first.                                          |
| A `@fork-*` or `@bk-*` snapshot on a named disk, an image or in `retired/`          | leftover: goes | A fork or a backup run marks it when it ends; it never outlives one.                |
| An image with no `@base`, or with it marked (ZFS); with no `rootfs.ext4` (XFS)      | leftover: goes | A build cut short before its snapshot, or a removal after its mark.                 |
| `imps/<id>` or `mem/<id>` with no disk                                              | leftover: goes | A destroy removes the disk first; nothing is left to boot.                          |
| `staging/` (ZFS), hidden `images/.new-*` (XFS)                                      | leftover: goes | A build or restore cut short; start settles it ([crash recovery](#crash-recovery)). |
| `retired/<uuid>` (ZFS)                                                              | reclaimed      | A delete that already happened; the [reclaim](#reclaim) frees it.                   |

Start and the hourly pass log one line for each orphan, with its dataset or directory, its size, its
creation time and its snapshots or checkpoints, then a count: once a start and once an hour. On XFS
the size counts the blocks it shares through reflink in full.

`imp gc --orphans` retires them as a destroy would: on ZFS it marks each snapshot on the orphan
(`zfs destroy -d`), unmounts it and renames it into `retired/`, and the reclaim frees it; on XFS it
removes the directory. `imp gc --orphans --dry-run` lists exactly that, and changes nothing.

A sweep while impd runs must never take storage that is about to get its row: a checkpoint's
snapshot exists before its row, an image build takes minutes, a fork's disk is made under its
source's lock. So every operation that touches storage joins a gate from before its first storage
call until its rows commit (`storage-gate.ts`): each imp operation under the imp's lock, an image
build or removal, and a backup run for its whole run. The GC runs only once nothing is in flight,
and operations that start meanwhile wait for it, which takes well under a second. A GC that waits
holds nothing back: `imp gc` gives up after 30 s with PRECONDITION_FAILED, the hourly pass after 10
minutes, and a backup run keeps it waiting for as long as it runs.

At runtime the sweep leaves alone:

- `staging/` (ZFS) and hidden `images/.new-*` and `images/.build-*` directories (XFS): builds and
  restores in flight. Start clears them, as [crash recovery](#crash-recovery) says.
- `retired/` (ZFS): the reclaim owns it.
- `backup/tree` and `backup/restore`: a backup run or a restore owns them.
- Image templates that have a name. `imp image rm` removes one that no imp uses; the GC takes only
  an image directory with no row.
