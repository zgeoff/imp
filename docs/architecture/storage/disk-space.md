# Disk space

Imp disks are sparse and their clones are thin, so the sizes imps are given can add up to far more
than the host holds. Three parts keep that safe: a budget that holds back a reserve of free space no
write may take, a count of what each imp really uses, and a sweep that removes what a crash left
behind without ever taking an imp's data. [Storage](./storage.md) covers the backends.

## Disk sizes

An imp's disk is a file larger than its image's filesystem, and the guest grows the filesystem to
fill it. A fork takes its source's size, a checkpoint keeps the size the disk had, and a restore or
a fork from a checkpoint takes that size back. A resize only grows a disk, because the guest's ext4
cannot shrink online. Both backends keep the disk as a file, so a grow is a truncate under the imp's
lock, and the guest follows by the imp's state:

- **Stopped**, or new before its first boot: impd grows the filesystem on the host. A filesystem
  that was not unmounted cleanly is left for the guest, since its journal must replay first.
- **Running**: impd asks Firecracker to read the file's size again, which tells the guest, and the
  agent's grow request resizes the filesystem online.
- **Sleeping**: the snapshot holds the old size, so the grow waits for the wake. A grow that fails
  stays pending for the next wake, and every cold boot grows the filesystem to fill its disk anyway.

A grown filesystem has new inode tables, which ext4 zeroes. On a sparse file those already read as
zeros, so zeroing them only allocates host space, and a grow on the host leaves them as holes. The
guest mounts its root so that an online grow zeroes them at once rather than in the background,
which still allocates that space.

## The budget

The disk budget is one ledger in impd. Each large write takes its estimate off the free space, under
a lock, until it ends, so two writes never pass on the same reading, and a write that would cut into
the reserve fails with `DISK_FULL` before it touches anything. The writes it covers are the ones
that can be large: a sleep's memory file, written at full size before its holes are dug; a watchdog
snapshot; an image build, which holds the unpacked tree and the ext4 file at once; an upload while
it arrives; a backup restore; and each new segment of a session log. A create and a fork take
nothing, because a thin clone writes nothing, and a checkpoint or a resize is refused only once the
reserve is already reached.

A wake is never refused: its disk and memory already exist, and a full disk must not strand an imp's
work. A sleep that is refused leaves its imp running, and the governor turns to another imp. Below
twice the reserve, impd warns once per episode and marks the storage low.

Free space is read with each backend's quirks in mind. On ZFS a write counts only once its
transaction group commits, and a destroy frees its blocks in the background, so the ledger keeps a
write's hold for a while after it ends and never counts freed space before ZFS reports it. On XFS in
a loop file, the filesystem can report room that the file's own host directory no longer has, so
free space is the smaller of the two.

Both backends also hold a little space back outside the ledger, so a destroy still runs on a full
disk: a reservation on ZFS, and a preallocated file on XFS. Removing it is how the owner gets out of
a full disk.

## Usage

Each imp's listing shows two numbers. Used is what a destroy of the imp would free: its disk, its
checkpoints and its memory snapshot. Shared is what it refers to that others hold too: the image and
the source of a fork. A pass measures every imp at start, on a timer and soon after an imp or a
checkpoint comes or goes, and listings read the last pass.

On ZFS one listing of the pool gives it all. On XFS a reflink leaves no count of who holds a block,
so impd reads every file's extents, imps, images and the backup tree alike, and calls an extent that
one owner holds that owner's and one that two hold shared. The read yields between calls and stops
at a time limit, so impd stays responsive; an imp a cut pass did not reach keeps its last count,
marked as possibly stale. impd never asks the kernel to flush before it reads, so blocks not yet
written count as their owner's.

## The sweep

A crash, or a removal that failed halfway, can leave storage that no row names. One sweep removes
it, at start, on a timer and on `imp gc`. Its rule comes from what a lost database would do: a
database restored from an older copy, or one that is gone while the pool survives, makes every newer
disk and checkpoint unnamed, and a sweep that took them would delete every imp. So the sweep takes
only what is provably impd's own and transient, such as a fork's or a backup's leftover snapshot or
an empty directory, and keeps every disk, image and checkpoint that no row names as an orphan. It
logs each orphan with its size and age, and `imp gc --orphans` retires them as a destroy would. A
destroy removes the files first and the row last, so a destroy never makes an orphan.

A sweep while impd runs must never take storage that is about to get its row: a checkpoint's
snapshot exists before its row, an image build takes minutes, and a fork's disk is made under its
source's lock. So every operation that touches storage joins a gate from before its first storage
call until its rows commit, and the sweep runs only once nothing is in flight. Operations that start
meanwhile wait for it, and a sweep that waits holds nothing back: it gives up after a while, and a
backup run keeps it waiting for as long as the run lasts. The sweep reads the database and the pool
inside the gate each time, so it never acts on a list made before.
