import { faker } from '@faker-js/faker';
import type { FirewallSlot } from '../egress/egress-ruleset';

// One imp's slot in the egress table: open, with no IPv6 and nothing in its
// sets. The tap follows the slot, as impd names it; the address is arbitrary.
export function buildMockFirewallSlot(overrides: Partial<FirewallSlot> = {}): FirewallSlot {
  const slot = overrides.slot ?? faker.number.int({ min: 0, max: 4095 });

  return {
    slot,
    tap: `imp${String(slot)}`,
    guestIp: faker.internet.ipv4(),
    guestIp6: null,
    mode: 'open',
    cidrs: [],
    addresses: [],
    ...overrides,
  };
}
