import { expect, test } from 'bun:test';
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOwnedFile,
  readRegularFile,
  requireSocket,
  setupLogFile,
  writeRegularFile,
} from './vm-files';

const OWNER = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

// a dir with a file a symlink must never reach, a symlink to it and a FIFO
function setupPlanted() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-files-'));
  const target = join(dir, 'target');

  writeFileSync(target, 'untouched');
  symlinkSync(target, join(dir, 'link'));

  Bun.spawnSync(['mkfifo', join(dir, 'fifo')]);

  return { dir, target };
}

test('a write replaces a planted symlink or FIFO, and never reaches past it', () => {
  const planted = setupPlanted();
  const dir = planted.dir;
  const target = planted.target;

  for (const name of ['link', 'fifo']) {
    writeRegularFile(join(dir, name), 'pid 1\n');

    expect(lstatSync(join(dir, name)).isFile()).toBeTrue();
    expect(readFileSync(join(dir, name), 'utf8')).toBe('pid 1\n');
  }

  expect(readFileSync(target, 'utf8')).toBe('untouched');
});

test('the log opens as a regular file in place of a symlink or FIFO', () => {
  const planted = setupPlanted();
  const dir = planted.dir;
  const target = planted.target;

  for (const name of ['link', 'fifo']) {
    const fd = setupLogFile(join(dir, name));

    writeSync(fd, 'line\n');
    closeSync(fd);

    expect(readFileSync(join(dir, name), 'utf8')).toBe('line\n');
  }

  expect(readFileSync(target, 'utf8')).toBe('untouched');
});

test('a read refuses a symlink and a FIFO without blocking', () => {
  const dir = setupPlanted().dir;

  expect(() => {
    readRegularFile(join(dir, 'link'));
  }).toThrow();

  expect(() => {
    readRegularFile(join(dir, 'fifo'));
  }).toThrow('not a regular file');

  expect(readRegularFile(join(dir, 'target'))).toBe('untouched');
});

test('a snapshot file is made new, in place of whatever was there', () => {
  const planted = setupPlanted();
  const dir = planted.dir;
  const target = planted.target;

  for (const name of ['link', 'fifo', 'target']) {
    createOwnedFile(join(dir, name), OWNER);

    const made = lstatSync(join(dir, name));

    expect(made.isFile()).toBeTrue();
    expect(made.size).toBe(0);
    expect(made.mode & 0o777).toBe(0o600);
  }

  expect(lstatSync(target).size).toBe(0);
});

test('impd connects only to a socket, never through a symlink', () => {
  const dir = setupPlanted().dir;
  const path = join(dir, 'api.sock');
  const server = Bun.listen({ unix: path, socket: { data: () => {} } });

  try {
    requireSocket(path);
    symlinkSync(path, join(dir, 'sock-link'));

    expect(() => {
      requireSocket(join(dir, 'sock-link'));
    }).toThrow('not a socket');

    expect(() => {
      requireSocket(join(dir, 'fifo'));
    }).toThrow('not a socket');
  } finally {
    server.stop(true);
  }
});
