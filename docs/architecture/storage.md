# Storage and images

imp keeps every disk as a copy-on-write clone on XFS. An image becomes an ext4 file once; each imp
disk, checkpoint and fork is a reflink clone of another file, so it costs no copy and no time (a
clone of a 32 GiB sparse rootfs takes about 3 ms).

## XFS with reflink

- `/var/lib/imp` is an XFS filesystem with reflink. On a dev box it is a sparse loop file; on bare
  metal it can be a real XFS partition. `host/scripts/setup-storage.sh` sets it up when the host
  container starts ([configuration](../guides/configuration.md#host-container)).
- The WSL 6.6 kernel needs `mkfs.xfs -m reflink=1 -i nrext64=0,exchange=0 -n parent=0`. Newer
  xfsprogs defaults do not mount on that kernel.
- A clone fails instead of falling back to a full copy.

## The data directory

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
```

`snapshot/` holds the memory of a sleeping imp, and `vm.json` what its VM booted with
([sleep and wake](./sleep-and-wake.md#snapshot-identity)).

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

- **Checkpoint.** The agent runs `sync` and `FIFREEZE` on `/`, impd takes a reflink clone of the imp
  disk, and the agent thaws. The freeze carries a 10 s timeout, so the agent thaws by itself if impd
  never sends thaw. A sleeping imp wakes first, because its memory holds page cache that is not on
  the disk yet. A stopped imp needs no freeze.
- **Restore.** impd stops the VM, clones the checkpoint to a new file, renames it over the disk,
  drops any memory snapshot, and boots again if the imp was awake. Memory and disk always belong
  together: a snapshot never wakes on a different disk.
- **Fork.** impd clones a disk, or a checkpoint, into a new imp. A fork is disk only. A memory fork
  would duplicate entropy and IDs across the clones.

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
