import { expect, test } from 'bun:test';
import { parseFirecrackerMemory } from './firecracker-memory';

test('owned memory is Pss_Anon plus Pss_Shmem over every VM; full PSS is summed apart', () => {
  // two VMs restored from one template: each has 2.6 MiB of its own binary
  // and a share of the template's clean pages on top of what it owns
  const output = ['330000 300000 8', '300000 270000 8', ''].join('\n');

  expect(parseFirecrackerMemory(output)).toEqual({
    pssMib: Math.floor(630_000 / 1024),
    ownedMib: Math.floor(570_016 / 1024),
    count: 2,
  });
});

test('it throws when a VM has no Pss_Anon line, rather than count it as 0', () => {
  expect(() => parseFirecrackerMemory('2048 1024 0\n4096 - 0\n')).toThrow('Pss_Anon');
});

test('it throws on a line that is not three numbers', () => {
  expect(() => parseFirecrackerMemory('4096\n')).toThrow('Pss_Anon');
});

test('it reads no VMs as zero', () => {
  expect(parseFirecrackerMemory('')).toEqual({ pssMib: 0, ownedMib: 0, count: 0 });
});
