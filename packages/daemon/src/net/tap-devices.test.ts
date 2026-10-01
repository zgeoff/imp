import { expect, test } from 'bun:test';
import type { CommandResult } from '../process/run-command';
import { deriveSlotAddress, parseSubnet } from './addressing';
import { createTapDevices } from './tap-devices';

const ADDRESS = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

function buildFakeIp(stderrByVerb: Readonly<Record<string, string>>) {
  const calls: string[] = [];

  const run = (argv: readonly string[]): Promise<CommandResult> => {
    calls.push(argv.join(' '));

    const stderr = stderrByVerb[argv[1] ?? ''] ?? '';

    return Promise.resolve({ exitCode: stderr === '' ? 0 : 2, stdout: '', stderr });
  };

  return { calls, run };
}

test('it creates the tap with the host end of the slot /30', async () => {
  const fake = buildFakeIp({});

  await createTapDevices(fake.run).setupTap(ADDRESS);

  expect(fake.calls).toEqual([
    'ip tuntap add imp1 mode tap',
    'ip addr add 10.66.0.5/30 dev imp1',
    'ip link set imp1 up',
  ]);
});

test('it treats an existing tap and address as done', async () => {
  const fake = buildFakeIp({
    tuntap: 'ioctl(TUNSETIFF): Device or resource busy',
    addr: 'Error: ipv4: Address already assigned.',
  });

  await createTapDevices(fake.run).setupTap(ADDRESS);

  expect(fake.calls).toHaveLength(3);
});

test('it fails on any other ip error', async () => {
  const fake = buildFakeIp({ link: 'Cannot find device "imp1"' });

  await createTapDevices(fake.run).removeTap('imp1');

  const failing = buildFakeIp({ tuntap: 'Operation not permitted' });

  expect(createTapDevices(failing.run).setupTap(ADDRESS)).rejects.toThrow('not permitted');
});
