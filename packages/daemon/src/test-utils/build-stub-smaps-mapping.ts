interface SmapsMappingOptions {
  // the mapping's start address and size
  readonly start: number;
  readonly mib: number;

  // as smaps prints them, such as `rw-p`
  readonly perms: string;

  // VmFlags past those the permissions give, such as `mg`
  readonly flags: string;

  // the file or the pseudo-file it maps; none for anonymous memory
  readonly backing?: string;
}

// One mapping of /proc/<pid>/smaps as the kernel prints it: its header, an
// Rss line and VmFlags. The flags follow the permissions, as show_smap_vma_flags
// prints them: rd, wr, ex, sh, then may-read/write/exec; ac for private writes.
export function buildStubSmapsMapping(options: Readonly<SmapsMappingOptions>): string {
  const end = options.start + options.mib * 1024 ** 2;
  const header = `${options.start.toString(16)}-${end.toString(16)} ${options.perms} 00000000 00:00 0 ${options.backing ?? ''}`;
  const [read, write, exec, share] = options.perms;

  const vmFlags = [
    read === 'r' ? 'rd' : '',
    write === 'w' ? 'wr' : '',
    exec === 'x' ? 'ex' : '',
    share === 's' ? 'sh' : '',
    'mr mw me',
    write === 'w' && share === 'p' ? 'ac' : '',
    options.flags,
  ].filter((flag) => flag !== '');

  return [header.trimEnd(), 'Rss:                 100 kB', `VmFlags: ${vmFlags.join(' ')}`].join(
    '\n',
  );
}
