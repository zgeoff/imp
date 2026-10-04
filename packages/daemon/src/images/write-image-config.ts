import { closeSync, constants, lstatSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ORPCError } from '@orpc/server';

// Writes /etc/imp/image.json into an unpacked image tree, whose names are
// the image's own: impd writes as root, so no step may follow a link out of
// the tree (docs/guides/images.md#what-the-guest-takes-from-the-image)
export function writeImageConfig(root: string, contents: string): void {
  const etc = join(root, 'etc');
  const dir = join(etc, 'imp');

  // no race: the tree is under impd's 0700 directory, and tar has exited
  createDirectory(etc, '/etc');
  createDirectory(dir, '/etc/imp');

  const file = join(dir, 'image.json');

  // rmSync looks at the name itself (lstat): a link goes, never its target
  rmSync(file, { recursive: true, force: true });

  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );

  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

// makes the directory when the name is free; a link or a file there refuses
// the image
function createDirectory(path: string, name: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });

  if (stat === undefined) {
    mkdirSync(path, { mode: 0o755 });

    return;
  }

  if (!stat.isDirectory()) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the image's ${name} is ${stat.isSymbolicLink() ? 'a symlink' : 'not a directory'}; impd writes /etc/imp/image.json there, so it must be a directory`,
    });
  }
}
