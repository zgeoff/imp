interface StubBlockDevice {
  // what `blkid -p` reads: the filesystem TYPE and its LABEL, or a signature with no TYPE, such
  // as a partition table
  readonly type?: string;
  readonly label?: string;
  readonly signature?: boolean;

  // where the device or a partition on it is mounted
  readonly mountpoints?: readonly string[];

  // the partitions or holders below the device
  readonly partitions?: readonly string[];
}

interface StubBlockDevices {
  // the partition that holds the root filesystem, and its disk
  readonly root: { readonly source: string; readonly disk: string };

  // the other block devices, by path
  readonly devices: Readonly<Record<string, StubBlockDevice>>;
}

export interface StubBlockDeviceScripts {
  readonly stat: string;
  readonly findmnt: string;
  readonly lsblk: string;
  readonly blkid: string;
}

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function buildPrintLines(lines: readonly string[]): string {
  return `printf '%s\\n' ${lines.map((line) => buildShellWord(line)).join(' ')}`;
}

function buildBlkidProbe(path: string, device: StubBlockDevice): string {
  if (device.type !== undefined) {
    return `echo ${buildShellWord(`${path}: TYPE="${device.type}"`)}`;
  }

  return device.signature === true ? `echo ${buildShellWord(`${path}: PTTYPE="gpt"`)}` : 'exit 2';
}

// Scripts for createStubBin that answer, for a table of block devices, the calls deploy/
// bootstrap.sh makes before it formats a device. A path the table lacks is no block device,
// a tag blkid does not find exits 2 as blkid does, and any other call fails as unexpected.
export function buildStubBlockDevices(stub: StubBlockDevices): StubBlockDeviceScripts {
  const entries = Object.entries(stub.devices);
  const blockPaths = [stub.root.source, stub.root.disk, ...entries.map(([path]) => path)];

  const stat = `case "$*" in
${blockPaths.map((path) => `  "-L -c %F "${buildShellWord(path)}) echo 'block special file' ;;`).join('\n')}
  "-L -c %F "*) echo "stat: cannot statx '\${*: -1}': No such file or directory" >&2; exit 1 ;;
  *) echo "unexpected: stat $*" >&2; exit 1 ;;
esac`;

  const findmnt = `case "$*" in
  "-n -o SOURCE /") echo ${buildShellWord(stub.root.source)} ;;
  *) echo "unexpected: findmnt $*" >&2; exit 1 ;;
esac`;

  const lsblk = `case "$*" in
  "-n -s -o PATH "${buildShellWord(stub.root.source)}) ${buildPrintLines([stub.root.source, stub.root.disk])} ;;
${entries
  .map(
    ([path, device]) =>
      `  "-n -o MOUNTPOINTS "${buildShellWord(path)}) ${buildPrintLines(device.mountpoints ?? [''])} ;;\n` +
      `  "-n -o PATH "${buildShellWord(path)}) ${buildPrintLines([path, ...(device.partitions ?? [])])} ;;`,
  )
  .join('\n')}
  *) echo "unexpected: lsblk $*" >&2; exit 1 ;;
esac`;

  const blkid = `case "$*" in
${entries
  .map(
    ([path, device]) =>
      `  "-p -s TYPE -o value "${buildShellWord(path)}) ${device.type === undefined ? 'exit 2' : `echo ${buildShellWord(device.type)}`} ;;\n` +
      `  "-p -s LABEL -o value "${buildShellWord(path)}) ${device.label === undefined ? 'exit 2' : `echo ${buildShellWord(device.label)}`} ;;\n` +
      `  "-p "${buildShellWord(path)}) ${buildBlkidProbe(path, device)} ;;`,
  )
  .join('\n')}
  *) echo "unexpected: blkid $*" >&2; exit 4 ;;
esac`;

  return { stat, findmnt, lsblk, blkid };
}
