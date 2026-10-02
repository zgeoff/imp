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

// `sysctls`: what `sysctl -n` reads for each key; every other key reads 1
function buildFakeIp(
  stderrByVerb: Readonly<Record<string, string>>,
  sysctls: Readonly<Record<string, string>> = {},
) {
  const calls: string[] = [];

  const run = (argv: readonly string[]): Promise<CommandResult> => {
    calls.push(argv.join(' '));

    if (argv[0] === 'sysctl' && argv[1] === '-n') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${sysctls[argv[2] ?? ''] ?? '1'}\n`,
        stderr: '',
      });
    }

    const stderr = stderrByVerb[argv[1] ?? ''] ?? '';

    return Promise.resolve({ exitCode: stderr === '' ? 0 : 2, stdout: '', stderr });
  };

  return { calls, run };
}

test('it creates the tap with the host end of the slot /30', async () => {
  const fake = buildFakeIp({});

  await createTapDevices(fake.run, () => null).setupTap(ADDRESS);

  expect(fake.calls).toEqual([
    'ip tuntap add imp1 mode tap',
    'ip link set imp1 address 06:01:0a:42:00:05',
    'ip addr add 10.66.0.5/30 dev imp1',
    'sysctl -n net.ipv6.conf.imp1.accept_ra',
    'sysctl -qw net.ipv6.conf.imp1.accept_ra=0',
    'sysctl -n net.ipv6.conf.imp1.accept_redirects',
    'sysctl -qw net.ipv6.conf.imp1.accept_redirects=0',
    'ip link set imp1 up',
  ]);
});

test('with IPv6, the tap gets fe80::1 without DAD and a route to the /128, RAs off first', async () => {
  const fake = buildFakeIp({});

  await createTapDevices(fake.run).setupTap(ADDRESS6);

  expect(fake.calls).toEqual([
    'ip tuntap add imp1 mode tap',
    'ip link set imp1 address 06:01:0a:42:00:05',
    'ip addr add 10.66.0.5/30 dev imp1',
    'sysctl -n net.ipv6.conf.imp1.accept_ra',
    'sysctl -qw net.ipv6.conf.imp1.accept_ra=0',
    'sysctl -n net.ipv6.conf.imp1.accept_redirects',
    'sysctl -qw net.ipv6.conf.imp1.accept_redirects=0',
    'sysctl -n net.ipv6.conf.imp1.disable_ipv6',
    'sysctl -qw net.ipv6.conf.imp1.disable_ipv6=0',
    'ip addr add fe80::1/64 dev imp1 nodad',
    'ip link set imp1 up',
    'ip -6 route replace fd12:3456:789a::a42:6/128 dev imp1',
  ]);
});

test('a key that already holds its value is only read, so a read-only /proc/sys works', async () => {
  const fake = buildFakeIp(
    { '-qw': 'sysctl: permission denied on key' },
    {
      'net.ipv6.conf.imp1.accept_ra': '0',
      'net.ipv6.conf.imp1.accept_redirects': '0',
      'net.ipv6.conf.imp1.disable_ipv6': '0',
    },
  );

  await createTapDevices(fake.run).setupTap(ADDRESS6);

  expect(fake.calls.filter((call) => call.startsWith('sysctl -qw'))).toEqual([]);

  const wrong = buildFakeIp({ '-qw': 'sysctl: permission denied on key' });

  const error = await readRejection(createTapDevices(wrong.run).setupTap(ADDRESS));

  expect(readErrorMessage(error)).toContain('net.ipv6.conf.imp1.accept_ra');
});

test('it treats an existing tap and address as done, and leaves the MAC its guest knows', async () => {
  const fake = buildFakeIp({
    tuntap: 'ioctl(TUNSETIFF): Device or resource busy',
    addr: 'Error: ipv4: Address already assigned.',
  });

  await createTapDevices(fake.run, () => null).setupTap(ADDRESS);

  expect(fake.calls).toHaveLength(7);
  expect(fake.calls.filter((call) => call.includes(' address '))).toEqual([]);
});

test('it fails on any other ip error', async () => {
  const fake = buildFakeIp({ link: 'Cannot find device "imp1"' });

  await createTapDevices(fake.run, () => null).removeTap('imp1');

  const failing = buildFakeIp({ tuntap: 'Operation not permitted' });

  const error = await readRejection(createTapDevices(failing.run, () => null).setupTap(ADDRESS));

  expect(readErrorMessage(error)).toContain('not permitted');
});

test('a jailed VM gets a tap it owns; one with another owner is made again', async () => {
  const owner = { uid: 900_001, gid: 900_001 };
  const fresh = buildFakeIp({});

  await createTapDevices(fresh.run, () => null).setupTap(ADDRESS, owner);

  expect(fresh.calls[0]).toBe('ip tuntap add imp1 mode tap user 900001 group 900001');

  const unowned = buildFakeIp({});

  await createTapDevices(unowned.run, () => ({ uid: -1, gid: -1 })).setupTap(ADDRESS, owner);

  expect(unowned.calls.slice(0, 2)).toEqual([
    'ip link del imp1',
    'ip tuntap add imp1 mode tap user 900001 group 900001',
  ]);

  const owned = buildFakeIp({ tuntap: 'ioctl(TUNSETIFF): Device or resource busy' });

  await createTapDevices(owned.run, () => owner).setupTap(ADDRESS, owner);

  expect(owned.calls[0]).toBe('ip tuntap add imp1 mode tap user 900001 group 900001');
});

test('an unjailed VM keeps whatever tap is there', async () => {
  const fake = buildFakeIp({ tuntap: 'ioctl(TUNSETIFF): Device or resource busy' });

  await createTapDevices(fake.run, () => ({ uid: 900_001, gid: 900_001 })).setupTap(ADDRESS);

  expect(fake.calls[0]).toBe('ip tuntap add imp1 mode tap');
});
