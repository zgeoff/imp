import { expect, test } from 'bun:test';
import { parseFirecrackerMemory } from './firecracker-memory';

test('it sums every VM and counts only anonymous and shmem pages as owned', () => {
  // two VMs restored from one template: each has 2.6 MiB of its own binary
  // and a share of the template's clean pages on top of what it owns
  const output = ['330000 300000 8', '300000 270000 8', ''].join('\n');

  expect(parseFirecrackerMemory(output)).toEqual({
    pssMib: Math.floor(630_000 / 1024),
    ownedMib: Math.floor(570_016 / 1024),
    count: 2,
  });
});

test('it skips a line a VM that exited mid-read left short', () => {
  expect(parseFirecrackerMemory('2048 1024 0\n4096\n\n')).toEqual({
    pssMib: 2,
    ownedMib: 1,
    count: 1,
  });
});

test('it reads no VMs as zero', () => {
  expect(parseFirecrackerMemory('')).toEqual({ pssMib: 0, ownedMib: 0, count: 0 });
});
