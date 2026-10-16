# Storage

Every imp disk is a copy-on-write clone. An image becomes one ext4 file once, and each disk,
checkpoint and fork shares its blocks with the one it came from, so making one costs no copy and
almost no time. Two backends do this behind one interface, and a host uses one of them for its whole
life: impd marks the data directory with the backend that wrote it and refuses to start on one the
other backend wrote, since nothing converts imps between them. [Disk space](./disk-space.md) covers
the budget, the usage counts and the sweep; [images](./images.md) covers how an image becomes a
file.

- **XFS with reflink**, the default. Each disk, checkpoint and fork is a reflink clone of another
  file. A clone fails rather than fall back to a full copy, so a host without reflink is refused at
  setup, not slowly filled. The data directory is an XFS filesystem, a real partition or a sparse
  loop file that the container's entrypoint sets up.
- **ZFS.** Each disk is a dataset, a checkpoint is a snapshot, and a fork is a clone. ZFS can send a
  disk and its checkpoints to another pool, which a move between two ZFS hosts uses
  ([moves](./moves.md#zfs)).

Either way a disk is a sparse ext4 file, on ZFS inside its dataset, so the guest sees the same
drive, and a backup restores across backends.

## The data directory

impd keeps everything under one data directory: the database, the system files, the images, a
directory per imp with its disk, its memory snapshot, its sockets and its session logs, the jails,
the boot templates, the tailnet node's state and the TLS files. `storage/data-layout.ts` is where
the code names every path. On ZFS the root dataset is mounted on the data directory, and the disks,
the images and the memory snapshots live in datasets of their own beneath it, so a checkpoint of a
disk never holds a stale memory file. Every dataset is mounted by impd inside the container, never
by the host, and impd mounts them all again at start before it adopts or wakes a VM.

## System files

impd copies the guest kernel and the system drive into the data directory at start. A changed kernel
is written beside the old one and renamed over it, so a running VM keeps its inode, and only a cold
boot reads the kernel. Each system drive goes under its own hash and is never written over: a
snapshot reopens its drive by path, and the guest's page cache holds blocks of those bytes, so the
bytes at that path must not change. So after an agent change the old drive stays, and a sleeping imp
wakes on it with its memory and its old agent, jailed or not
([snapshot identity](../lifecycle/sleep-and-wake.md#snapshot-identity)). At start impd deletes every
drive that is not the current one and that no snapshot, live VM or boot template names.

## Checkpoints, restores and forks

These work the same on both backends; only the clone differs.

- **Checkpoint.** The agent syncs and freezes the guest's filesystem, impd clones the disk, and the
  agent thaws it. The freeze carries its own timeout, so a guest whose host never thaws it thaws by
  itself. A sleeping imp wakes first, because its memory holds page cache that is not on the disk
  yet, and a stopped imp needs no freeze.
- **Restore.** impd clones the checkpoint first, so a clone that fails leaves the imp as it was. It
  then kills the VM, drops any memory snapshot, swaps the clone in for the disk, and boots again if
  the imp was awake. The kill skips the guest's shutdown, because its disk and memory are being
  thrown away. A swap that fails after the kill leaves the imp stopped on its old disk, as after a
  power cut, which ext4's journal handles.
- **Fork.** impd clones a disk or a checkpoint into a new imp. A fork is disk only, because a memory
  fork would duplicate entropy and IDs across the copies.

A restore keeps every other checkpoint, older and newer: nothing is rolled back, and each stays a
clone of the disk it was taken from.

## ZFS

A ZFS host keeps a few more rules, all from one fact: a dataset cannot go while a clone or a
snapshot still needs its blocks.

- **Retired datasets.** A destroyed disk, a replaced disk after a restore, and a removed image are
  renamed into a retired area rather than destroyed. Each snapshot that no checkpoint needs any more
  is marked for deferred destroy, so ZFS removes it with its last clone.
- **Reclaim.** Once every snapshot on a retired dataset is marked, impd promotes the clone of its
  newest snapshot. A promote hands that clone the retired dataset's snapshots and leaves the retired
  one with none, so it can go. That is how a fork outlives its source, and how a removed image hands
  its blocks to the imps cloned from it. impd reclaims in the background after every delete, destroy
  and restore, and before anything else at start. It never promotes a clone in staging, which a
  restore or a backup run destroys soon, because the promote would take the retired dataset's
  snapshots with it.
- **Lanes.** Dataset changes run one at a time inside impd. A checkpoint and a live fork have a lane
  of their own, because the guest is frozen while they run, so they never wait behind a reclaim.
- **A reserve.** A dataset with nothing in it holds back a little of the pool, so a destroy still
  runs on a full pool ([disk space](./disk-space.md#the-budget)).
- **Versions.** The container's ZFS tools and the host's ZFS module must share a major version, and
  impd refuses to start when they do not. A different minor version only logs a warning, since impd
  runs nothing a 2.x module lacks.
- **Minimum module versions.** A ZFS module needs 2.3.7 on the 2.3 line or 2.4.2 on the 2.4 line,
  and no 2.2 or older release has the fix. An older module can overrun a buffer when a SIGKILL or a
  cgroup OOM kill lands during a read (openzfs/zfs#15918). impd sends both kills to Firecracker, at
  stop and at each VM's memory cap, so one can land during a read of an imp's disk. With hardened
  usercopy the kernel then oopses, the oops kills Firecracker, and its hold on the disk's dataset
  lasts until a reboot. impd refuses to start on an older module unless the host's override is set
  ([the host](../host.md#what-the-host-gives)). With the override it logs a warning at start and
  lists the same warning in `/health`.

## Crash recovery

Every multi-step change stages its new state under a name of its own and renames it into place last,
so a crash leaves a name that says what was in flight. On XFS that rename is atomic. On ZFS, at
start, impd settles each staging dataset: a restore whose old disk is already retired is finished by
renaming its clone into place, and one whose disk is still there never happened, so its clone goes.
Builds, backup clones and move streams in staging are temporary and go too, and so do fork, backup
and move snapshots that no running work holds. The memory snapshot goes before a restore's swap, so
neither outcome pairs it with the wrong disk. What a crash does not explain stays for the sweep
([disk space](./disk-space.md#the-sweep)).
