import { expect, test } from 'bun:test';
import { buildMockNetworkRecord } from './build-mock-network-record';

test('it builds a default network record', () => {
  expect(buildMockNetworkRecord()).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toSatisfy((name: string) => /^[a-z0-9]{10}$/v.test(name)),
    createdAt: expect.toBeValidDate(),
    imps: [],
  });
});

test('it applies overrides on top of the defaults', () => {
  const network = buildMockNetworkRecord({
    id: 'net-1',
    name: 'lab',
    createdAt: new Date(1_800_000_000_000),
    imps: ['db', 'web'],
  });

  expect(network).toStrictEqual({
    id: 'net-1',
    name: 'lab',
    createdAt: new Date(1_800_000_000_000),
    imps: ['db', 'web'],
  });
});
