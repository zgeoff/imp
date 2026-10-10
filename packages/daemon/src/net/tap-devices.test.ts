import { expect, test } from 'bun:test';
import { buildStubIpCommand } from '../test-utils/build-stub-ip-command';
import { deriveSlotAddress, parseSubnet } from './addressing';
import { parsePrefix64 } from './addressing6';
import { createTapDevices } from './tap-devices';

test('it creates the tap with the host end of the slot /30', async () => {
  // a kernel with IPv6 gives each new tap these keys at their defaults
  const ip = buildStubIpCommand({
    sysctls: {
      'net.ipv6.conf.imp1.accept_ra': '1',
      'net.ipv6.conf.imp1.accept_redirects': '1',
      'net.ipv6.conf.imp1.disable_ipv6': '0',
    },
  });

  const address = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  await createTapDevices(ip.run, () => null).setupTap(address);

  expect(ip.calls).toStrictEqual([
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

test('it gives an IPv6 tap fe80::1 without DAD and a route to the /128, with RAs off first', async () => {
  // a container that starts its taps with IPv6 off
  const ip = buildStubIpCommand({
    sysctls: {
      'net.ipv6.conf.imp1.accept_ra': '1',
      'net.ipv6.conf.imp1.accept_redirects': '1',
      'net.ipv6.conf.imp1.disable_ipv6': '1',
    },
  });

  const address = deriveSlotAddress(1, {
    subnet: parseSubnet('10.66.0.0/16'),
    portBase: 20_000,
    prefix6: parsePrefix64('fd12:3456:789a::/64'),
  });

  await createTapDevices(ip.run, () => null).setupTap(address);

  expect(ip.calls).toStrictEqual([
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

  expect(ip.readSysctl('net.ipv6.conf.imp1.disable_ipv6')).toBe('0');
});

test('it only reads a key that already holds its value, so a read-only /proc/sys works', async () => {
  const ip = buildStubIpCommand({
    failures: { 'sysctl -qw': 'sysctl: permission denied on key' },
    sysctls: {
      'net.ipv6.conf.imp1.accept_ra': '0',
      'net.ipv6.conf.imp1.accept_redirects': '0',
      'net.ipv6.conf.imp1.disable_ipv6': '0',
    },
  });

  const address = deriveSlotAddress(1, {
    subnet: parseSubnet('10.66.0.0/16'),
    portBase: 20_000,
    prefix6: parsePrefix64('fd12:3456:789a::/64'),
  });

  await createTapDevices(ip.run, () => null).setupTap(address);

  expect(ip.calls).toStrictEqual([
    'ip tuntap add imp1 mode tap',
    'ip link set imp1 address 06:01:0a:42:00:05',
    'ip addr add 10.66.0.5/30 dev imp1',
    'sysctl -n net.ipv6.conf.imp1.accept_ra',
    'sysctl -n net.ipv6.conf.imp1.accept_redirects',
    'sysctl -n net.ipv6.conf.imp1.disable_ipv6',
    'ip addr add fe80::1/64 dev imp1 nodad',
    'ip link set imp1 up',
    'ip -6 route replace fd12:3456:789a::a42:6/128 dev imp1',
  ]);
});

test('it fails on a sysctl key it cannot write', () => {
  const ip = buildStubIpCommand({
    failures: { 'sysctl -qw': 'sysctl: permission denied on key' },
    sysctls: { 'net.ipv6.conf.imp1.accept_ra': '1' },
  });

  const address = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(createTapDevices(ip.run, () => null).setupTap(address)).rejects.toThrowWithMessage(
    Error,
    'sysctl net.ipv6.conf.imp1.accept_ra: sysctl: permission denied on key',
  );
});

// the stub has no sysctl keys, as a kernel without IPv6
test('it skips a sysctl key a kernel without IPv6 does not have', async () => {
  const ip = buildStubIpCommand();
  const address = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  await createTapDevices(ip.run, () => null).setupTap(address);

  expect(ip.calls).toStrictEqual([
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

test('it treats an existing tap and address as done, and leaves the MAC its guest knows', async () => {
  const ip = buildStubIpCommand({
    failures: {
      'ip tuntap': 'ioctl(TUNSETIFF): Device or resource busy',
      'ip addr': 'Error: ipv4: Address already assigned.',
    },
    sysctls: {
      'net.ipv6.conf.imp1.accept_ra': '1',
      'net.ipv6.conf.imp1.accept_redirects': '1',
    },
  });

  const address = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  await createTapDevices(ip.run, () => null).setupTap(address);

  expect(ip.calls).toStrictEqual([
    'ip tuntap add imp1 mode tap',
    'ip addr add 10.66.0.5/30 dev imp1',
    'sysctl -n net.ipv6.conf.imp1.accept_ra',
    'sysctl -qw net.ipv6.conf.imp1.accept_ra=0',
    'sysctl -n net.ipv6.conf.imp1.accept_redirects',
    'sysctl -qw net.ipv6.conf.imp1.accept_redirects=0',
    'ip link set imp1 up',
  ]);
});

test('it fails on any other ip error', () => {
  const ip = buildStubIpCommand({ failures: { 'ip tuntap': 'Operation not permitted' } });
  const address = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(createTapDevices(ip.run, () => null).setupTap(address)).rejects.toThrowWithMessage(
    Error,
    'ip tuntap add imp1 mode tap: Operation not permitted',
  );
});

test.each(['Cannot find device "imp1"', 'Device "imp1" does not exist.'])(
  'it removes a tap that is already gone, when ip says %p',
  async (stderr) => {
    const ip = buildStubIpCommand({ failures: { 'ip link del': stderr } });

    await expect(createTapDevices(ip.run, () => null).removeTap('imp1')).toResolve();
  },
);

test('it fails a tap removal on any other ip error', () => {
  const ip = buildStubIpCommand({ failures: { 'ip link del': 'Operation not permitted' } });

  expect(createTapDevices(ip.run, () => null).removeTap('imp1')).rejects.toThrowWithMessage(
    Error,
    'ip link del imp1: Operation not permitted',
  );
});

test('it gives a jailed VM a new tap it owns', async () => {
  const ip = buildStubIpCommand();
  const address = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  await createTapDevices(ip.run, () => null).setupTap(address, { uid: 900_001, gid: 900_001 });

  expect(ip.calls[0]).toBe('ip tuntap add imp1 mode tap user 900001 group 900001');
});

test('it makes a jailed VM tap again when another owner holds it', async () => {
  const ip = buildStubIpCommand();
  const address = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  await createTapDevices(ip.run, () => ({ uid: -1, gid: -1 })).setupTap(address, {
    uid: 900_001,
    gid: 900_001,
  });

  expect(ip.calls.slice(0, 2)).toStrictEqual([
    'ip link del imp1',
    'ip tuntap add imp1 mode tap user 900001 group 900001',
  ]);
});

test('it keeps a jailed VM tap that its owner already holds', async () => {
  const ip = buildStubIpCommand({
    failures: { 'ip tuntap': 'ioctl(TUNSETIFF): Device or resource busy' },
  });

  const address = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  await createTapDevices(ip.run, () => ({ uid: 900_001, gid: 900_001 })).setupTap(address, {
    uid: 900_001,
    gid: 900_001,
  });

  expect(ip.calls[0]).toBe('ip tuntap add imp1 mode tap user 900001 group 900001');
});

test('it keeps whatever tap is there for an unjailed VM', async () => {
  const ip = buildStubIpCommand({
    failures: { 'ip tuntap': 'ioctl(TUNSETIFF): Device or resource busy' },
  });

  const address = deriveSlotAddress(1, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  await createTapDevices(ip.run, () => ({ uid: 900_001, gid: 900_001 })).setupTap(address);

  expect(ip.calls[0]).toBe('ip tuntap add imp1 mode tap');
});
