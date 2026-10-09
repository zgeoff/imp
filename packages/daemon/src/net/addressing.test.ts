import { expect, test } from 'bun:test';
import {
  countSlots,
  deriveSlotAddress,
  findGuestSlot,
  findPeerSlot,
  formatCidr4,
  isTailnetOverlap,
  parseIpv4,
  parseSubnet,
} from './addressing';
import { parsePrefix64 } from './addressing6';

test('it gives a /16 16384 slots', () => {
  expect(countSlots(parseSubnet('10.66.0.0/16'))).toBe(16_384);
});

test('it addresses slot 0 at the start of the subnet', () => {
  const plan = { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 };

  expect(deriveSlotAddress(0, plan)).toStrictEqual({
    slot: 0,
    tap: 'imp0',
    hostIp: '10.66.0.1',
    guestIp: '10.66.0.2',
    prefixLength: 30,
    netmask: '255.255.255.252',
    guestMac: '06:00:0a:42:00:02',
    hostMac: '06:01:0a:42:00:01',
    guestIp6: null,
    tailnetPort: 20_000,
  });
});

test('it addresses a slot that crosses an octet boundary', () => {
  const plan = { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 };

  expect(deriveSlotAddress(64, plan)).toStrictEqual({
    slot: 64,
    tap: 'imp64',
    hostIp: '10.66.1.1',
    guestIp: '10.66.1.2',
    prefixLength: 30,
    netmask: '255.255.255.252',
    guestMac: '06:00:0a:42:01:02',
    hostMac: '06:01:0a:42:01:01',
    guestIp6: null,
    tailnetPort: 20_064,
  });
});

test('it addresses the last slot at the end of the subnet', () => {
  const plan = { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 };
  const address = deriveSlotAddress(16_383, plan);

  expect(address.hostIp).toBe('10.66.255.253');
  expect(address.guestIp).toBe('10.66.255.254');
  expect(address.tailnetPort).toBe(36_383);
});

test("it gives a slot an IPv6 address in the plan's /64", () => {
  const plan = {
    subnet: parseSubnet('10.66.0.0/16'),
    portBase: 20_000,
    prefix6: parsePrefix64('fd12:3456:789a::/64'),
  };

  expect(deriveSlotAddress(1, plan).guestIp6).toBe('fd12:3456:789a::a42:6');
});

test.each([
  ['the first slot past the end', 16_384],
  ['a negative slot', -1],
  ['a fractional slot', 1.5],
])('it rejects %s', (_label, slot) => {
  const plan = { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 };

  expect(() => deriveSlotAddress(slot, plan)).toThrowWithMessage(
    RangeError,
    `slot ${String(slot)} is outside the subnet`,
  );
});

test('it parses a subnet above 128.0.0.0 without sign overflow', () => {
  const subnet = parseSubnet('192.168.0.0/24');

  expect(subnet).toStrictEqual({ network: 0xc0_a8_00_00, prefixLength: 24 });
});

test('it addresses the last slot of a subnet above 128.0.0.0', () => {
  const subnet = parseSubnet('192.168.0.0/24');

  expect(deriveSlotAddress(63, { subnet, portBase: 20_000 }).guestIp).toBe('192.168.0.254');
});

test.each([
  ['10.66.0.0', 'no prefix'],
  ['10.66.0.300/16', 'an octet over 255'],
  ['10.66.0/16', 'three octets'],
  ['10.66.0.0/16/1', 'two prefixes'],
  ['10.66.0.0/x', 'a prefix that is not a number'],
])('it rejects %s, which has %s, as not a CIDR', (cidr) => {
  expect(() => parseSubnet(cidr)).toThrowWithMessage(Error, `subnet is not an IPv4 CIDR: ${cidr}`);
});

test('it rejects a subnet with host bits set', () => {
  expect(() => parseSubnet('10.66.0.1/16')).toThrowWithMessage(
    Error,
    'subnet has host bits set: 10.66.0.1/16',
  );
});

test.each([
  ['10.66.0.0/31', 'too small'],
  ['10.0.0.0/7', 'too large'],
])('it rejects %s as %s for slots', (cidr) => {
  expect(() => parseSubnet(cidr)).toThrowWithMessage(
    Error,
    `subnet prefix must be between /8 and /30: ${cidr}`,
  );
});

test.each([
  ['10.0.0.0/8', 8],
  ['10.66.0.0/30', 30],
])('it accepts %s at the edge of the prefix range', (cidr, prefixLength) => {
  expect(parseSubnet(cidr).prefixLength).toBe(prefixLength);
});

test('it reads a dotted IPv4 address as a number', () => {
  expect(parseIpv4('10.66.0.2')).toBe(0x0a_42_00_02);
});

test('it refuses the v4-mapped form unless asked for it', () => {
  expect(parseIpv4('::ffff:10.66.0.2')).toBeNull();
});

test('it reads the v4-mapped form when asked for it', () => {
  expect(parseIpv4('::ffff:10.66.0.2', true)).toBe(0x0a_42_00_02);
});

test.each(['10.66.0', '10.66.0.256', '::1', 'a.b.c.d', '10.66.0.2 '])(
  'it refuses %p as an IPv4 address',
  (text) => {
    expect(parseIpv4(text, true)).toBeNull();
  },
);

test.each([
  ['10.66.0.2', '10.66.0.1', 0],
  ['10.66.1.6', '10.66.1.5', 65],
  ['::ffff:10.66.0.6', '::ffff:10.66.0.5', 1],
])('it maps peer %s on gateway %s to slot %d', (peer, local, slot) => {
  expect(findPeerSlot(peer, local, parseSubnet('10.66.0.0/16'))).toBe(slot);
});

test.each([
  ['10.66.0.6', '10.66.0.1', "another slot's gateway"],
  ['10.66.0.1', '10.66.0.0', 'the host end as the peer'],
  ['10.67.0.2', '10.67.0.1', 'a pair outside the subnet'],
  ['172.17.0.1', '172.17.0.2', 'a pair off the imp network'],
  ['example.com', '10.66.0.1', 'a peer that is not an address'],
])('it maps peer %s on %s to no slot: %s', (peer, local) => {
  expect(findPeerSlot(peer, local, parseSubnet('10.66.0.0/16'))).toBeNull();
});

test.each([
  ['10.66.0.2', 0],
  ['::ffff:10.66.1.6', 65],
])('it finds the slot whose guest address is %s', (address, slot) => {
  expect(findGuestSlot(address, parseSubnet('10.66.0.0/16'))).toBe(slot);
});

test.each([
  ['10.66.0.1', "a slot's host end"],
  ['10.66.0.3', "a slot's broadcast address"],
  ['10.67.0.2', 'an address outside the subnet'],
  ['example.com', 'a name'],
])('it finds no slot for %s, %s', (address) => {
  expect(findGuestSlot(address, parseSubnet('10.66.0.0/16'))).toBeNull();
});

test.each([
  ['100.64.0.0/16', true],
  ['100.0.0.0/8', true],
  ['100.127.255.252/30', true],
  ['100.128.0.0/16', false],
  ['10.66.0.0/16', false],
])('it reads %s as overlapping the tailnet range: %p', (cidr, overlaps) => {
  expect(isTailnetOverlap(parseSubnet(cidr))).toBe(overlaps);
});

test.each([
  ['172.17.0.2/16', '172.17.0.0/16'],
  ['10.66.0.9', '10.66.0.9/32'],
  ['0.0.0.0/0', '0.0.0.0/0'],
])('it writes %s as the network %s', (text, network) => {
  expect(formatCidr4(text)).toBe(network);
});

test.each(['10.66.0.0/33', '10.66.0.0/1/2', '10.66.0.0/x', 'fd00::/8', ''])(
  'it gives no network for %p',
  (text) => {
    expect(formatCidr4(text)).toBeNull();
  },
);
