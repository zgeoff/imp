// The size column of `df -k`'s last line, in KiB: a guest's view of one
// filesystem. Throws on output that holds no such number.
export function parseDfSizeKib(stdout: string): number {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  const sizeKib = Number(last.split(/\s+/u)[1]);

  if (!Number.isInteger(sizeKib)) {
    throw new TypeError(`no size in df output: ${JSON.stringify(stdout)}`);
  }

  return sizeKib;
}

// Where impd keeps an imp's root disk inside the host container, by storage
// backend (docs/architecture/storage/storage.md).
export function buildImpDiskPath(backend: 'xfs' | 'zfs', id: string): string {
  return backend === 'xfs'
    ? `/var/lib/imp/imps/${id}/disk.ext4`
    : `/var/lib/imp/imps/${id}/disk/rootfs.ext4`;
}
