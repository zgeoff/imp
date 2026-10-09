import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubFirecrackerProcess } from '../test-utils/start-stub-firecracker-process';
import {
  countUnsharedMib,
  parseSmapsRollup,
  readCpuTicks,
  readOwnedRamMib,
  readRssMib,
  readUnsharedRamMib,
  readVmMemory,
} from './vm-stats';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-stats-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('#parseSmapsRollup reads the kB fields of smaps_rollup', () => {
  const fields = parseSmapsRollup(
    [
      '7f0000000000-7fffffffffff ---p 00000000 00:00 0                          [rollup]',
      'Rss:              349184 kB',
      'Pss_Anon:          15360 kB',
      'Private_Dirty:     15400 kB',
      'THPeligible:    0',
    ].join('\n'),
  );

  expect([...fields]).toStrictEqual([
    ['Rss', 349_184],
    ['Pss_Anon', 15_360],
    ['Private_Dirty', 15_400],
  ]);
});

test('#countUnsharedMib counts anonymous and shmem pages in full, in MiB', () => {
  expect(
    countUnsharedMib(
      new Map([
        ['Anonymous', 2048],
        ['Pss_Anon', 512],
        ['Pss_Shmem', 1024],
      ]),
    ),
  ).toBe(3);
});

test('#readOwnedRamMib reads a live firecracker in whole MiB', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(readOwnedRamMib(child.pid, join(ctx.dir, 'api.sock'))).toSatisfy(Number.isSafeInteger);
});

test('#readRssMib reads a live firecracker in whole MiB', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(readRssMib(child.pid, join(ctx.dir, 'api.sock'))).toSatisfy(Number.isSafeInteger);
});

test('#readUnsharedRamMib reads a live firecracker in whole MiB', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(readUnsharedRamMib(child.pid, join(ctx.dir, 'api.sock'))).toSatisfy(Number.isSafeInteger);
});

test('#readOwnedRamMib reads nothing for a pid that serves another socket', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(readOwnedRamMib(child.pid, join(ctx.dir, 'other.sock'))).toBeNull();
});

test('#readRssMib reads nothing for a pid that serves another socket', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(readRssMib(child.pid, join(ctx.dir, 'other.sock'))).toBeNull();
});

test('#readUnsharedRamMib reads nothing for a pid that serves another socket', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(readUnsharedRamMib(child.pid, join(ctx.dir, 'other.sock'))).toBeNull();
});

test('#readVmMemory reads the counted and the resident size of a live firecracker', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  const memory = readVmMemory(child.pid, join(ctx.dir, 'api.sock'));

  expect(memory.ramMib).toSatisfy(Number.isSafeInteger);
  expect(memory.rssMib).toSatisfy(Number.isSafeInteger);
});

test('#readVmMemory reads nothing for a pid that serves another socket', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(readVmMemory(child.pid, join(ctx.dir, 'other.sock'))).toStrictEqual({
    ramMib: null,
    rssMib: null,
  });
});

test('#readCpuTicks reads the user and system ticks of a live process', () => {
  expect(readCpuTicks(process.pid)).toSatisfy(Number.isSafeInteger);
});

test('#readCpuTicks reads nothing for a process that is gone', async () => {
  const child = Bun.spawn(['true']);

  await child.exited;

  expect(readCpuTicks(child.pid)).toBeNull();
});
