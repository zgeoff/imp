import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeUnusedSystemDrives } from './remove-unused-system-drives';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'imp-system-drives-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  return { dataDir };
}

test('it deletes the drives not named and the copies a crash cut short', async () => {
  const ctx = await setupTest();

  const drives = join(ctx.dataDir, 'system', 'drives');

  mkdirSync(drives, { recursive: true });
  writeFileSync(join(drives, 'aaaa.squashfs'), 'drive a');
  writeFileSync(join(drives, 'bbbb.squashfs'), 'drive b');
  writeFileSync(join(drives, 'bbbb.squashfs.new'), 'half');

  const removed = removeUnusedSystemDrives(ctx.dataDir, new Set(['aaaa.squashfs']));

  expect(removed).toIncludeSameMembers(['bbbb.squashfs', 'bbbb.squashfs.new']);
  expect(existsSync(join(drives, 'bbbb.squashfs'))).toBeFalse();
  expect(existsSync(join(drives, 'bbbb.squashfs.new'))).toBeFalse();
});

test('it never deletes a drive it is told to keep', async () => {
  const ctx = await setupTest();

  const drives = join(ctx.dataDir, 'system', 'drives');

  mkdirSync(drives, { recursive: true });
  writeFileSync(join(drives, 'aaaa.squashfs'), 'drive a');
  writeFileSync(join(drives, 'bbbb.squashfs'), 'drive b');
  removeUnusedSystemDrives(ctx.dataDir, new Set(['aaaa.squashfs']));

  expect(existsSync(join(drives, 'aaaa.squashfs'))).toBeTrue();
});

test('it deletes nothing from a data dir with no drives', async () => {
  const ctx = await setupTest();

  expect(removeUnusedSystemDrives(ctx.dataDir, new Set())).toStrictEqual([]);
});
