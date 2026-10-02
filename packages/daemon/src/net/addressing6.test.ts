import { expect, test } from 'bun:test';
import {
  buildUlaPrefix,
  deriveGuestIp6,
  formatCidr6,
  formatIpv6,
  isInPrefix,
  parseIpv6,
  parsePrefix64,
} from './addressing6';

test('it reads and writes IPv6 addresses in their canonical form', () => {
  const parsed = parseIpv6('2001:0DB8:0:0:0:0:0:1');

  expect(parsed).toBe((0x20_01_0d_b8n << 96n) + 1n);
  expect(formatIpv6(parsed ?? 0n)).toBe('2001:db8::1');
  expect(parseIpv6('::')).toBe(0n);
  expect(parseIpv6('::ffff:10.0.0.1')).toBe((0xff_ffn << 32n) + 0x0a_00_00_01n);
});

test('it refuses what is not an IPv6 address', () => {
  for (const text of ['10.0.0.1', '1::2::3', 'fe80::1%eth0', 'example.com', '1:2:3:4:5:6:7:8:9']) {
    expect(parseIpv6(text)).toBeNull();
  }
});

test('IMP_SUBNET6 must be a /64 with no host bits', () => {
  expect(parsePrefix64('2001:db8:c:0::/64')).toEqual({
    network: 0x20_01_0d_b8_00_0c_00_00n << 64n,
    text: '2001:db8:c::/64',
  });

  expect(parsePrefix64('2001:db8:c::/48')).toBeNull();
  expect(parsePrefix64('2001:db8:c::1/64')).toBeNull();
  expect(parsePrefix64('10.0.0.0/8')).toBeNull();
});

test('a ULA prefix is fd, the 40-bit global ID and subnet 0', () => {
  const prefix = buildUlaPrefix(Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xff]));

  expect(prefix.text).toBe('fd12:3456:789a::/64');
});

test("an imp's address carries its IPv4 address as the interface ID", () => {
  const prefix = parsePrefix64('fd12:3456:789a::/64');

  if (prefix === null) {
    throw new Error('no prefix');
  }

  const address = deriveGuestIp6(prefix, 0x0a_42_00_02);

  expect(address).toBe('fd12:3456:789a::a42:2');
  expect(isInPrefix(prefix, address)).toBeTrue();
  expect(isInPrefix(prefix, 'fd12:3456:789b::a42:2')).toBeFalse();
});

test('a CIDR is written canonically with its host bits cleared', () => {
  expect(formatCidr6('2001:0DB8:000A::0001/64')).toBe('2001:db8:a::/64');
  expect(formatCidr6('2001:db8::1')).toBe('2001:db8::1/128');
  expect(formatCidr6('2001:db8::/129')).toBeNull();
  expect(formatCidr6('10.0.0.0/8')).toBeNull();
});
