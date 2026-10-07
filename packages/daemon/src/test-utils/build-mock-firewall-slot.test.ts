import { expect, test } from 'bun:test';
import { isIPv4 } from 'node:net';
import { buildMockFirewallSlot } from './build-mock-firewall-slot';

test('it builds a default firewall slot', () => {
  const slot = buildMockFirewallSlot();

  expect(slot).toStrictEqual({
    slot: expect.toBeWithin(0, 4096),
    tap: `imp${String(slot.slot)}`,
    guestIp: expect.toSatisfy(isIPv4),
    guestIp6: null,
    mode: 'open',
    cidrs: [],
    addresses: [],
  });
});

test('it applies overrides on top of the defaults', () => {
  const slot = buildMockFirewallSlot({
    slot: 3,
    guestIp: '10.66.0.14',
    guestIp6: 'fd12:3456:789a::a42:e',
    mode: 'box',
    cidrs: ['203.0.113.0/24'],
    addresses: ['140.82.112.3'],
  });

  expect(slot).toStrictEqual({
    slot: 3,
    tap: 'imp3',
    guestIp: '10.66.0.14',
    guestIp6: 'fd12:3456:789a::a42:e',
    mode: 'box',
    cidrs: ['203.0.113.0/24'],
    addresses: ['140.82.112.3'],
  });
});
