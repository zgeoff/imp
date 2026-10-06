const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// An image's ext4 holds its files and room to spare; each imp disk grows past
// it (docs/architecture/storage.md#disk-sizes)
const ROOTFS_MIN_BYTES = 4 * GIB;
const ROOTFS_SPARE_BYTES = 2 * GIB;

// mkfs.ext4's default: one inode per 16 KiB
const BYTES_PER_INODE = 16_384;

// An ext4 file's own blocks, mostly its journal: 64 MiB below 16 GiB, then
// 1/128 of the filesystem up to 1 GiB. 1/64, at least 128 MiB, holds it and
// the group metadata.
const ROOTFS_OVERHEAD_MIN_BYTES = 128 * MIB;
const ROOTFS_OVERHEAD_SHARE = 64;

interface RootfsPlan {
  readonly bytes: number;

  // null leaves mkfs.ext4 its default count
  readonly inodes: number | null;
}

// The rootfs size for a tree: its bytes and a fifth more, plus 2 GiB, in
// whole GiB and at least 4 GiB. A tree of many small files gets twice its
// inode count, since a grow adds inodes only in proportion to the size.
export function planRootfs(tree: Readonly<{ bytes: number; inodes: number }>): RootfsPlan {
  const wanted = Math.ceil((tree.bytes * 1.2 + ROOTFS_SPARE_BYTES) / GIB) * GIB;
  const bytes = Math.max(ROOTFS_MIN_BYTES, wanted);
  const inodes = tree.inodes * 2;

  return { bytes, inodes: inodes > bytes / BYTES_PER_INODE ? inodes : null };
}

// what the rootfs of a tree of treeBytes takes on the host besides the
// tree's own blocks, for the disk hold of a build
// (docs/architecture/storage.md#disk-budget)
export function planRootfsOverhead(treeBytes: number): number {
  const rootfs = planRootfs({ bytes: treeBytes, inodes: 0 }).bytes;

  return Math.max(ROOTFS_OVERHEAD_MIN_BYTES, Math.ceil(rootfs / ROOTFS_OVERHEAD_SHARE));
}
