import { faker } from '@faker-js/faker';
import type { NetworkMember } from '../db/networks';

// One imp on one network, as listNetworkMembers reads it: every field is
// arbitrary, so a test that needs a slot to match its address sets both.
export function buildMockNetworkMember(overrides: Partial<NetworkMember> = {}): NetworkMember {
  return {
    network: faker.word.noun(),
    impId: faker.string.uuid(),
    name: faker.word.noun(),
    slot: faker.number.int({ min: 0, max: 4095 }),
    guestIp: faker.internet.ipv4(),
    ...overrides,
  };
}
