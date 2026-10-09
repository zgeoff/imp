import { expect, onTestFinished, test } from 'bun:test';
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-files-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // the test's own uid, so the chown works without root
  const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  return { dir, owner };
}

test('it writes a regular file in place of a planted symlink and leaves its target untouched', () => {
  const ctx = setupTest();
  const target = join(ctx.dir, 'target');
  const link = join(ctx.dir, 'link');

  writeFileSync(target, 'untouched');
  symlinkSync(target, link);
  writeRegularFile(link, 'pid 1\n');

  expect(lstatSync(link).isFile()).toBeTrue();
  expect(readFileSync(link, 'utf8')).toBe('pid 1\n');
  expect(readFileSync(target, 'utf8')).toBe('untouched');
});

test('it writes a regular file in place of a planted FIFO without blocking', () => {
  const ctx = setupTest();
  const fifo = join(ctx.dir, 'fifo');

  Bun.spawnSync(['mkfifo', fifo]);

  writeRegularFile(fifo, 'pid 1\n');

  expect(lstatSync(fifo).isFile()).toBeTrue();
  expect(readFileSync(fifo, 'utf8')).toBe('pid 1\n');
});

test('it opens the log as a regular file in place of a planted symlink and leaves its target untouched', () => {
  const ctx = setupTest();
  const target = join(ctx.dir, 'target');
  const link = join(ctx.dir, 'link');

  writeFileSync(target, 'untouched');
  symlinkSync(target, link);

  const fd = setupLogFile(link);

  writeSync(fd, 'line\n');
  closeSync(fd);

  expect(lstatSync(link).isFile()).toBeTrue();
  expect(readFileSync(link, 'utf8')).toBe('line\n');
  expect(readFileSync(target, 'utf8')).toBe('untouched');
});

test('it opens the log as a regular file in place of a planted FIFO without blocking', () => {
  const ctx = setupTest();
  const fifo = join(ctx.dir, 'fifo');

  Bun.spawnSync(['mkfifo', fifo]);

  const fd = setupLogFile(fifo);

  writeSync(fd, 'line\n');
  closeSync(fd);

  expect(lstatSync(fifo).isFile()).toBeTrue();
  expect(readFileSync(fifo, 'utf8')).toBe('line\n');
});

test('it reads a regular file', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'file');

  writeFileSync(file, 'untouched');

  expect(readRegularFile(file)).toBe('untouched');
});

test('it refuses to read through a symlink', () => {
  const ctx = setupTest();
  const target = join(ctx.dir, 'target');
  const link = join(ctx.dir, 'link');

  writeFileSync(target, 'untouched');
  symlinkSync(target, link);

  expect(() => readRegularFile(link)).toThrow(expect.objectContaining({ code: 'ELOOP' }));
});

test('it refuses to read a FIFO without blocking', () => {
  const ctx = setupTest();
  const fifo = join(ctx.dir, 'fifo');

  Bun.spawnSync(['mkfifo', fifo]);

  expect(() => readRegularFile(fifo)).toThrowWithMessage(Error, `${fifo} is not a regular file`);
});

test('it makes a snapshot file new in place of a planted symlink and leaves its target untouched', () => {
  const ctx = setupTest();
  const target = join(ctx.dir, 'target');
  const link = join(ctx.dir, 'link');

  writeFileSync(target, 'untouched');
  symlinkSync(target, link);
  createOwnedFile(link, ctx.owner);

  const made = lstatSync(link);

  expect(made.isFile()).toBeTrue();
  expect(made.size).toBe(0);
  expect(made.mode & 0o777).toBe(0o600);
  expect(readFileSync(target, 'utf8')).toBe('untouched');
});

test('it makes a snapshot file new in place of a planted FIFO', () => {
  const ctx = setupTest();
  const fifo = join(ctx.dir, 'fifo');

  Bun.spawnSync(['mkfifo', fifo]);

  createOwnedFile(fifo, ctx.owner);

  const made = lstatSync(fifo);

  expect(made.isFile()).toBeTrue();
  expect(made.size).toBe(0);
  expect(made.mode & 0o777).toBe(0o600);
});

test('it makes a snapshot file new and empty in place of an old one', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'mem');

  writeFileSync(file, 'old snapshot');
  createOwnedFile(file, ctx.owner);

  const made = lstatSync(file);

  expect(made.isFile()).toBeTrue();
  expect(made.size).toBe(0);
  expect(made.mode & 0o777).toBe(0o600);
  expect(made.uid).toBe(ctx.owner.uid);
});

test('it accepts a socket', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'api.sock');
  const server = Bun.listen({ unix: path, socket: { data: () => {} } });

  onTestFinished(() => {
    server.stop(true);
  });

  expect(() => {
    requireSocket(path);
  }).not.toThrow();
});

test('it refuses a symlink to a socket', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'api.sock');
  const link = join(ctx.dir, 'sock-link');
  const server = Bun.listen({ unix: path, socket: { data: () => {} } });

  onTestFinished(() => {
    server.stop(true);
  });

  symlinkSync(path, link);

  expect(() => {
    requireSocket(link);
  }).toThrowWithMessage(Error, `${link} is not a socket`);
});

test('it refuses a FIFO in place of a socket', () => {
  const ctx = setupTest();
  const fifo = join(ctx.dir, 'fifo');

  Bun.spawnSync(['mkfifo', fifo]);

  expect(() => {
    requireSocket(fifo);
  }).toThrowWithMessage(Error, `${fifo} is not a socket`);
});
