import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, fsyncSync, openSync, statfsSync, writeSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startDiskSampler } from './start-disk-sampler';

async function setupTest() {
  // a tmpfs no other test writes: the sampler waits for free space to hold
  // still, which the shared temp dir's busy disk never does
  const mount = await mkdtemp(join('/dev/shm', 'disk-sampler-'));

  onTestFinished(() => rm(mount, { recursive: true, force: true }));

  return { mount };
}

test('it reports a run that resolves as built', async () => {
  const ctx = await setupTest();
  const sampler = await startDiskSampler(ctx.mount);
  const trial = await sampler.measure(() => Promise.resolve());

  expect(trial.outcome).toBe('built');
});

test('it reports a run that rejects with a code by its code', async () => {
  const ctx = await setupTest();
  const sampler = await startDiskSampler(ctx.mount);

  const trial = await sampler.measure(() =>
    Promise.reject(Object.assign(new Error('full'), { code: 'DISK_FULL' })),
  );

  expect(trial.outcome).toBe('DISK_FULL');
});

test('it reports a run that rejects with no code by its text', async () => {
  const ctx = await setupTest();
  const sampler = await startDiskSampler(ctx.mount);
  const trial = await sampler.measure(() => Promise.reject(new Error('the build failed')));

  expect(trial.outcome).toBe('Error: the build failed');
});

test('it reports no settled use for a run that never marks its write', async () => {
  const ctx = await setupTest();
  const sampler = await startDiskSampler(ctx.mount);
  const trial = await sampler.measure(() => Promise.resolve());

  expect(trial.settledBytes).toBe(0);
});

test('it sees the peak use of a file a run writes and removes', async () => {
  const ctx = await setupTest();
  const sampler = await startDiskSampler(ctx.mount);

  const trial = await sampler.measure(async () => {
    const file = join(ctx.mount, 'big');
    const fd = openSync(file, 'w');

    writeSync(fd, new Uint8Array(32 * 1024 ** 2).fill(1));
    fsyncSync(fd);
    closeSync(fd);

    sampler.markWritten();

    await rm(file);
  });

  expect(trial.peakBytes).toBeGreaterThanOrEqual(16 * 1024 ** 2);
});

test('it reads the settled use at the moment the run marks its write', async () => {
  const ctx = await setupTest();
  const sampler = await startDiskSampler(ctx.mount);

  const trial = await sampler.measure(async () => {
    const file = join(ctx.mount, 'big');
    const fd = openSync(file, 'w');

    writeSync(fd, new Uint8Array(32 * 1024 ** 2).fill(1));
    fsyncSync(fd);
    closeSync(fd);

    sampler.markWritten();

    await rm(file);
  });

  expect(trial.settledBytes).toBeGreaterThanOrEqual(16 * 1024 ** 2);
});

test('it refuses a fill when less than the room is free above the reserve', async () => {
  const ctx = await setupTest();
  const sampler = await startDiskSampler(ctx.mount);

  const stats = statfsSync(ctx.mount);

  expect(sampler.fill(1024, stats.bavail * stats.bsize)).rejects.toThrow(
    'B free above the reserve',
  );
});

test('it refuses a fill over a file it did not make, and keeps that file', async () => {
  const ctx = await setupTest();

  const taken = join(ctx.mount, 'taken');

  await Bun.write(taken, 'not the sampler’s');

  const sampler = await startDiskSampler(ctx.mount, taken);

  const stats = statfsSync(ctx.mount);

  // a fill of about 64 MiB, were the path free
  const filling = sampler.fill(1024 ** 2, stats.bavail * stats.bsize - 64 * 1024 ** 2);

  await filling.catch(() => {});

  expect(filling).rejects.toThrowWithMessage(
    Error,
    `${taken} is there already, and not the sampler's`,
  );

  const kept = await Bun.file(taken).text();

  expect(kept).toBe('not the sampler’s');
});

test('it fails a fill whose fallocate fails, with its stderr', async () => {
  const ctx = await setupTest();

  // a filler in a directory that is not there, so fallocate cannot make it
  const sampler = await startDiskSampler(ctx.mount, join(ctx.mount, 'missing', 'filler'));

  const stats = statfsSync(ctx.mount);

  expect(
    sampler.fill(1024 ** 2, stats.bavail * stats.bsize - 64 * 1024 ** 2),
  ).rejects.toThrowWithMessage(
    Error,
    /^fallocate failed: fallocate: cannot open .*No such file or directory/v,
  );
});

test('it removes its filler when the test ends', async () => {
  const ctx = await setupTest();

  // the filler's own directory, which setupTest's cleanup of the mount does
  // not reach before the check below
  const fillers = await mkdtemp(join('/dev/shm', 'disk-sampler-fillers-'));
  const sampler = await startDiskSampler(ctx.mount, join(fillers, 'filler'));

  const stats = statfsSync(ctx.mount);

  await sampler.fill(1024 ** 2, stats.bavail * stats.bsize - 8 * 1024 ** 2);

  // registered after fill's own removal, so it runs once that has
  onTestFinished(async () => {
    const left = await readdir(fillers);

    expect(left).toStrictEqual([]);
  });

  // the directory goes last, so the check above sees only the sampler's removal
  onTestFinished(() => rm(fillers, { recursive: true, force: true }));
});
