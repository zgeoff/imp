import {
  closeSync,
  constants,
  fchownSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';

// Files impd opens as root next to a VM (docs/architecture/daemon.md#the-jailer).
// Never through a symlink, and never a FIFO, which would block the event loop.
const SAFE_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK;

// an fd on the regular file at `path`; anything else there is replaced
function openRegularFile(path: string, flags: number, mode: number): number {
  try {
    const fd = openSync(path, flags | constants.O_CREAT | SAFE_FLAGS, mode);

    if (fstatSync(fd).isFile()) {
      return fd;
    }

    closeSync(fd);
  } catch (error) {
    if (!isNotRegular(error)) {
      throw error;
    }
  }

  // unlink never follows; a file planted again in between fails the create
  rmSync(path, { force: true, recursive: true });

  return openSync(path, flags | constants.O_CREAT | constants.O_EXCL | SAFE_FLAGS, mode);
}

// ELOOP: a symlink; ENXIO: a FIFO with no reader
function isNotRegular(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  return error.code === 'ELOOP' || error.code === 'ENXIO' || error.code === 'EISDIR';
}

// an append-only fd for a VM's log, handed to Firecracker as stdout
export function setupLogFile(path: string): number {
  return openRegularFile(path, constants.O_WRONLY | constants.O_APPEND, 0o644);
}

export function writeRegularFile(path: string, text: string): void {
  const fd = openRegularFile(path, constants.O_WRONLY, 0o644);

  try {
    ftruncateSync(fd, 0);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

// throws unless `path` is a regular file
export function readRegularFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | SAFE_FLAGS);

  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`${path} is not a regular file`);
    }

    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

// A new, empty file for Firecracker to write, owned by `owner`: it can write
// the file, not replace it, in a directory impd owns.
export function createOwnedFile(path: string, owner: Readonly<{ uid: number; gid: number }>): void {
  rmSync(path, { force: true, recursive: true });

  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | SAFE_FLAGS,
    0o600,
  );

  try {
    fchownSync(fd, owner.uid, owner.gid);
  } finally {
    closeSync(fd);
  }
}

// a socket impd connects to as root: never a symlink to one elsewhere
export function requireSocket(path: string): void {
  if (!lstatSync(path).isSocket()) {
    throw new Error(`${path} is not a socket`);
  }
}
