import { expect, test } from 'bun:test';
import { parseFirecrackerMemory, readSmallestOwnedMib } from './firecracker-memory';

test('owned memory is Pss_Anon plus Pss_Shmem over every VM; full PSS is summed apart', () => {
  // two VMs restored from one template: each has 2.6 MiB of its own binary
  // and a share of the template's clean pages on top of what it owns
  const output = ['imp-a 330000 300000 8', 'imp-b 300000 270000 8', ''].join('\n');
  const memory = parseFirecrackerMemory(output);

  expect(memory.pssMib).toBe(Math.floor(630_000 / 1024));
  expect(memory.ownedMib).toBe(Math.floor(570_016 / 1024));
  expect(memory.count).toBe(2);

  expect(memory.ownedByImpMib).toEqual(
    new Map([
      ['imp-a', Math.floor(300_008 / 1024)],
      ['imp-b', Math.floor(270_008 / 1024)],
    ]),
  );
});

test('it throws when a VM has no Pss_Anon line, rather than count it as 0', () => {
  expect(() => parseFirecrackerMemory('imp-a 2048 1024 0\nimp-b 4096 - 0\n')).toThrow('Pss_Anon');
});

test('it throws on a line that is not an id and three numbers', () => {
  expect(() => parseFirecrackerMemory('imp-a 4096\n')).toThrow('Pss_Anon');
});

test('a VM with no --id counts in the totals, under no imp', () => {
  const memory = parseFirecrackerMemory('- 2048 1024 0\n');

  expect(memory.ownedMib).toBe(1);
  expect(memory.ownedByImpMib.size).toBe(0);
});

test('it reads no VMs as zero', () => {
  expect(parseFirecrackerMemory('')).toEqual({
    pssMib: 0,
    ownedMib: 0,
    count: 0,
    ownedByImpMib: new Map(),
  });
});

test('the per-imp figure comes from smaps when impd still shows a stale one', () => {
  // impd's last sample of imp 2 came before its fill: 195 MiB in `imp ls`
  const impdRamMib = new Map([
    ['imp-1', 321],
    ['imp-2', 195],
  ]);

  const memory = parseFirecrackerMemory('imp-1 340000 328704 8\nimp-2 300000 284672 8\n');
  const perImp = readSmallestOwnedMib(['imp-1', 'imp-2'], memory);

  expect(perImp).toBe(278);
  expect(perImp).not.toBe(Math.min(...impdRamMib.values()));
});

test('an imp with no Firecracker throws', () => {
  expect(() => readSmallestOwnedMib(['imp-9'], parseFirecrackerMemory(''))).toThrow('imp-9');
});
