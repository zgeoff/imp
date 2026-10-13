import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  fsyncSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCopyDurably, writeFileDurably, writeFileDurablyAsync } from './write-file-durably';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'durable-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it replaces a file with the new text', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'state.json');

  writeFileSync(path, 'old');
  writeFileDurably(path, 'new');

  expect(readFileSync(path, 'utf8')).toBe('new');
});

test('it writes bytes as they are', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'blob');

  writeFileDurably(path, new Uint8Array([0, 255, 7]));

  expect([...readFileSync(path)]).toStrictEqual([0, 255, 7]);
});

test('it gives a new file mode 0644 by default', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'state.json');

  writeFileDurably(path, 'x');

  expect(statSync(path).mode & 0o777).toBe(0o644);
});

test('it gives a new file the mode it is passed', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'secret');

  writeFileDurably(path, 'x', { mode: 0o600 });

  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('it flushes the new file and then its directory', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'state.json');
  const synced: string[] = [];

  writeFileDurably(path, 'x', {
    sync: (fd) => {
      synced.push(readlinkSync(`/proc/self/fd/${String(fd)}`));

      fsyncSync(fd);
    },
  });

  expect(synced).toStrictEqual([`${path}.new`, ctx.dir]);
});

test('it leaves no temp file behind', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'state.json');

  writeFileDurably(path, 'x');

  expect(existsSync(`${path}.new`)).toBeFalse();
});

test('it never writes through a symlink a crash left at the temp path', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'state.json');
  const target = join(ctx.dir, 'elsewhere');

  writeFileSync(target, 'untouched');
  symlinkSync(target, `${path}.new`);
  writeFileDurably(path, 'x');

  expect(readFileSync(target, 'utf8')).toBe('untouched');
});

test('it replaces a file asynchronously with the mode it is passed', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'meta.json');

  writeFileSync(path, 'old');

  await writeFileDurablyAsync(path, 'new', { mode: 0o600 });

  expect(readFileSync(path, 'utf8')).toBe('new');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('it leaves no temp file behind an asynchronous write', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'meta.json');

  await writeFileDurablyAsync(path, 'x');

  expect(existsSync(`${path}.new`)).toBeFalse();
});

test('it copies a file over another', () => {
  const ctx = setupTest();
  const from = join(ctx.dir, 'from');
  const to = join(ctx.dir, 'to');

  writeFileSync(from, 'copied');
  writeFileSync(to, 'old');
  writeCopyDurably(from, to);

  expect(readFileSync(to, 'utf8')).toBe('copied');
});
