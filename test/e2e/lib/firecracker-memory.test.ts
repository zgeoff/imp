import { expect, test } from 'bun:test';
import {
  parseFirecrackerMemory,
  readImpIdFromArgv,
  readSmallestOwnedMib,
} from './firecracker-memory';

const JAILED = '/firecracker --id';

test('owned memory is Pss_Anon plus Pss_Shmem over every VM; full PSS is summed apart', () => {
  // two VMs restored from one template: each has 2.6 MiB of its own binary
  // and a share of the template's clean pages on top of what it owns
  const output = [`330000 300000 8 ${JAILED} imp-a`, `300000 270000 8 ${JAILED} imp-b`, ''].join(
    '\n',
  );

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
  expect(() =>
    parseFirecrackerMemory(`2048 1024 0 ${JAILED} imp-a\n4096 - 0 ${JAILED} imp-b\n`),
  ).toThrow('Pss_Anon');
});

test('it throws on a line without three sizes', () => {
  expect(() => parseFirecrackerMemory('4096\n')).toThrow('Pss_Anon');
});

test('a VM with no imp in its command line counts in the totals, under no imp', () => {
  const memory = parseFirecrackerMemory('2048 1024 0 /usr/local/bin/firecracker\n');

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

  const memory = parseFirecrackerMemory(
    `340000 328704 8 ${JAILED} imp-1\n300000 284672 8 ${JAILED} imp-2\n`,
  );

  const perImp = readSmallestOwnedMib(['imp-1', 'imp-2'], memory);

  expect(perImp).toBe(278);
  expect(perImp).not.toBe(Math.min(...impdRamMib.values()));
});

test('an imp with no Firecracker throws', () => {
  expect(() => readSmallestOwnedMib(['imp-9'], parseFirecrackerMemory(''))).toThrow('imp-9');
});

test('a jailed VM names its imp with the --id the jailer passes on', () => {
  const argv = [
    '/firecracker',
    '--id',
    'abc123',
    '--start-time-us',
    '1',
    '--api-sock',
    '/run/api.sock',
  ];

  expect(readImpIdFromArgv(argv)).toBe('abc123');
});

test('an unjailed VM (IMP_JAILER=false) names its imp in its API socket path', () => {
  const argv = [
    '/usr/local/bin/firecracker',
    '--api-sock',
    '/var/lib/imp/imps/abc123/run/api.sock',
  ];

  expect(readImpIdFromArgv(argv)).toBe('abc123');
});
