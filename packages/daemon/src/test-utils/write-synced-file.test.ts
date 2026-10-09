import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSyncedFile } from './write-synced-file';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'write-synced-file-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it writes the text to a new file', () => {
  const ctx = setupTest();

  writeSyncedFile(join(ctx.dir, 'rootfs.ext4'), 'one');

  expect(readFileSync(join(ctx.dir, 'rootfs.ext4'), 'utf8')).toBe('one');
});

test('it replaces the whole of a longer file', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'rootfs.ext4'), 'a longer text');
  writeSyncedFile(join(ctx.dir, 'rootfs.ext4'), 'two');

  expect(readFileSync(join(ctx.dir, 'rootfs.ext4'), 'utf8')).toBe('two');
});

test('it throws when the dir does not exist', () => {
  const ctx = setupTest();

  expect(() => {
    writeSyncedFile(join(ctx.dir, 'gone', 'rootfs.ext4'), 'one');
  }).toThrow(/^ENOENT: no such file or directory, open '.+\/gone\/rootfs\.ext4'$/);
});
