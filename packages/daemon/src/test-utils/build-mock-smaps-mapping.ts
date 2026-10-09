interface SmapsMappingOptions {
  // the mapping's start address and size
  readonly start: number;
  readonly mib: number;

  // as smaps prints them: `rw-p`, and VmFlags past the common ones
  readonly perms: string;
  readonly flags: string;

  // the file or the pseudo-file it maps; none for anonymous memory
  readonly backing?: string;
}

// One mapping of /proc/<pid>/smaps as the kernel prints it: its header line,
// an Rss line and its VmFlags.
export function buildMockSmapsMapping(options: Readonly<SmapsMappingOptions>): string {
  const end = options.start + options.mib * 1024 ** 2;
  const header = `${options.start.toString(16)}-${end.toString(16)} ${options.perms} 00000000 00:00 0 ${options.backing ?? ''}`;

  return [
    header.trimEnd(),
    'Rss:                 100 kB',
    `VmFlags: rd wr mr mw me ac ${options.flags}`.trimEnd(),
  ].join('\n');
}
