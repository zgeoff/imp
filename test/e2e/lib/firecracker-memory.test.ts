import { expect, test } from 'bun:test';
import {
  parseFirecrackerMemory,
  readImpIdFromArgv,
  readSmallestOwnedMib,
} from './firecracker-memory';

test('#parseFirecrackerMemory sums Pss_Anon plus Pss_Shmem as owned memory over every VM, and full PSS apart', () => {
  // two VMs restored from one template: each has 2.6 MiB of its own binary
  // and a share of the template's clean pages on top of what it owns
  const output =
    '330000 300000 8 /firecracker --id imp-a\n300000 270000 8 /firecracker --id imp-b\n';

  expect(parseFirecrackerMemory(output)).toStrictEqual({
    pssMib: 615,
    ownedMib: 556,
    count: 2,
    ownedByImpMib: new Map([
      ['imp-a', 292],
      ['imp-b', 263],
    ]),
  });
});

test('#parseFirecrackerMemory throws when a VM has no Pss_Anon line, rather than count it as 0', () => {
  expect(() =>
    parseFirecrackerMemory(
      '2048 1024 0 /firecracker --id imp-a\n4096 - 0 /firecracker --id imp-b\n',
    ),
  ).toThrowWithMessage(
    Error,
    "smaps_rollup without Pss, Pss_Anon and Pss_Shmem: '4096 - 0 /firecracker --id imp-b'",
  );
});

test('#parseFirecrackerMemory throws on a line without three sizes', () => {
  expect(() => parseFirecrackerMemory('4096\n')).toThrowWithMessage(
    Error,
    "smaps_rollup without Pss, Pss_Anon and Pss_Shmem: '4096'",
  );
});

test('#parseFirecrackerMemory counts a VM with no imp in its command line in the totals, under no imp', () => {
  expect(parseFirecrackerMemory('2048 1024 0 /usr/local/bin/firecracker\n')).toStrictEqual({
    pssMib: 2,
    ownedMib: 1,
    count: 1,
    ownedByImpMib: new Map(),
  });
});

test('#parseFirecrackerMemory reads no VMs as zero', () => {
  expect(parseFirecrackerMemory('')).toStrictEqual({
    pssMib: 0,
    ownedMib: 0,
    count: 0,
    ownedByImpMib: new Map(),
  });
});

test('#readSmallestOwnedMib takes the smallest figure from smaps', () => {
  // impd's last sample of imp-2 came before its fill and showed 195 MiB;
  // smaps shows what it owns now
  const memory = parseFirecrackerMemory(
    '340000 328704 8 /firecracker --id imp-1\n300000 284672 8 /firecracker --id imp-2\n',
  );

  expect(readSmallestOwnedMib(['imp-1', 'imp-2'], memory)).toBe(278);
});

test('#readSmallestOwnedMib throws for an imp with no Firecracker', () => {
  expect(() => readSmallestOwnedMib(['imp-9'], parseFirecrackerMemory(''))).toThrowWithMessage(
    Error,
    'no Firecracker for imp imp-9',
  );
});

test('#readImpIdFromArgv reads a jailed VM’s imp from the --id the jailer passes on', () => {
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

test('#readImpIdFromArgv reads an unjailed VM’s imp from its API socket path', () => {
  // IMP_JAILER=false: no --id
  const argv = [
    '/usr/local/bin/firecracker',
    '--api-sock',
    '/var/lib/imp/imps/abc123/run/api.sock',
  ];

  expect(readImpIdFromArgv(argv)).toBe('abc123');
});

test('#readImpIdFromArgv reads no imp from a VM with neither --id nor an imp socket', () => {
  expect(readImpIdFromArgv(['/usr/local/bin/firecracker'])).toBeNull();
});
