import { expect, test } from 'bun:test';
import { isIPv4 } from 'node:net';
import { buildMockNetworkMember } from './build-mock-network-member';

test('it builds a default network member', () => {
  const member = buildMockNetworkMember();

  expect(member).toStrictEqual({
    network: expect.toBeString(),
    impId: expect.toBeString(),
    name: expect.toBeString(),
    slot: expect.toBeWithin(0, 4096),
    guestIp: expect.toSatisfy(isIPv4),
  });
});

test('it applies overrides on top of the defaults', () => {
  const member = buildMockNetworkMember({
    network: 'lab',
    name: 'web',
    slot: 1,
    guestIp: '10.66.0.6',
  });

  expect(member).toStrictEqual({
    network: 'lab',
    impId: expect.toBeString(),
    name: 'web',
    slot: 1,
    guestIp: '10.66.0.6',
  });
});
