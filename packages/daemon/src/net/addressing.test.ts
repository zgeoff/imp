import { expect, test } from 'bun:test';
import { countSlots, deriveSlotAddress, parseSubnet } from './addressing';

const plan = { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 };

test('it gives a /16 16384 slots', () => {
  expect(countSlots(plan.subnet)).toBe(16_384);
});

test('it addresses slot 0 at the start of the subnet', () => {
  expect(deriveSlotAddress(0, plan)).toEqual({
    slot: 0,
    tap: 'imp0',
    hostIp: '10.66.0.1',
    guestIp: '10.66.0.2',
    prefixLength: 30,
    netmask: '255.255.255.252',
    guestMac: '06:00:0a:42:00:02',
    tailnetPort: 20_000,
  });
});

test('it addresses a slot that crosses an octet boundary', () => {
  const address = deriveSlotAddress(64, plan);

  expect(address.hostIp).toBe('10.66.1.1');
  expect(address.guestIp).toBe('10.66.1.2');
  expect(address.guestMac).toBe('06:00:0a:42:01:02');
  expect(address.tap).toBe('imp64');
});

test('it addresses the last slot at the end of the subnet', () => {
  const address = deriveSlotAddress(16_383, plan);

  expect(address.hostIp).toBe('10.66.255.253');
  expect(address.guestIp).toBe('10.66.255.254');
  expect(address.tailnetPort).toBe(36_383);
});

test('it rejects a slot outside the subnet', () => {
  expect(() => deriveSlotAddress(16_384, plan)).toThrow(RangeError);
  expect(() => deriveSlotAddress(-1, plan)).toThrow(RangeError);
  expect(() => deriveSlotAddress(1.5, plan)).toThrow(RangeError);
});

test('it parses a subnet above 128.0.0.0 without sign overflow', () => {
  const subnet = parseSubnet('192.168.0.0/24');

  expect(countSlots(subnet)).toBe(64);
  expect(deriveSlotAddress(63, { subnet, portBase: 20_000 }).guestIp).toBe('192.168.0.254');
});

test('it rejects malformed, misaligned and too-small subnets', () => {
  expect(() => parseSubnet('10.66.0.0')).toThrow('not an IPv4 CIDR');
  expect(() => parseSubnet('10.66.0.300/16')).toThrow('not an IPv4 CIDR');
  expect(() => parseSubnet('10.66.0.1/16')).toThrow('host bits');
  expect(() => parseSubnet('10.66.0.0/31')).toThrow('/30');
});
