import { expect, test } from 'bun:test';
import type { CommandResult } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import { readRejection } from '../read-rejection';
import { deriveSlotAddress, parseSubnet } from './addressing';
import { parsePrefix64 } from './addressing6';
import { createTapDevices } from './tap-devices';

const ADDRESS = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

const ADDRESS6 = deriveSlotAddress(1, {
  subnet: parseSubnet('10.66.0.0/16'),
  portBase: 20_000,
  prefix6: parsePrefix64('fd12:3456:789a::/64'),
});

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
    'sysctl -qw net.ipv6.conf.imp1.accept_ra=0',
    'sysctl -qw net.ipv6.conf.imp1.accept_redirects=0',
    'ip link set imp1 up',
  ]);
});

test('with IPv6, the tap gets fe80::1 without DAD and a route to the /128, RAs off first', async () => {
  const fake = buildFakeIp({});

  await createTapDevices(fake.run).setupTap(ADDRESS6);

  expect(fake.calls).toEqual([
    'ip tuntap add imp1 mode tap',
    'ip addr add 10.66.0.5/30 dev imp1',
    'sysctl -qw net.ipv6.conf.imp1.accept_ra=0',
    'sysctl -qw net.ipv6.conf.imp1.accept_redirects=0',
    'sysctl -qw net.ipv6.conf.imp1.disable_ipv6=0',
    'ip addr add fe80::1/64 dev imp1 nodad',
    'ip link set imp1 up',
    'ip -6 route replace fd12:3456:789a::a42:6/128 dev imp1',
  ]);
});

test('it treats an existing tap and address as done', async () => {
  const fake = buildFakeIp({
    tuntap: 'ioctl(TUNSETIFF): Device or resource busy',
    addr: 'Error: ipv4: Address already assigned.',
  });

  await createTapDevices(fake.run).setupTap(ADDRESS);

  expect(fake.calls).toHaveLength(5);
});

test('it fails on any other ip error', async () => {
  const fake = buildFakeIp({ link: 'Cannot find device "imp1"' });

  await createTapDevices(fake.run).removeTap('imp1');

  const failing = buildFakeIp({ tuntap: 'Operation not permitted' });

  const error = await readRejection(createTapDevices(failing.run).setupTap(ADDRESS));

  expect(readErrorMessage(error)).toContain('not permitted');
});
