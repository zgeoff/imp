import { expect, test } from 'bun:test';
import { buildMockLeaseRecord } from './build-mock-lease-record';

test('it builds a default lease record', () => {
  expect(buildMockLeaseRecord()).toStrictEqual({
    impId: expect.toBeString(),
    principal: expect.toStartWith('token:'),
    label: expect.toBeString(),
    display: expect.toBeString(),
    until: null,
    createdAt: expect.toBeValidDate(),
  });
});

test('it applies overrides on top of the defaults', () => {
  const record = buildMockLeaseRecord({
    impId: 'imp-1',
    principal: 'legacy',
    label: 'hold',
    display: 'ci',
    until: new Date(1_800_000_060_000),
    createdAt: new Date(1_800_000_000_000),
  });

  expect(record).toStrictEqual({
    impId: 'imp-1',
    principal: 'legacy',
    label: 'hold',
    display: 'ci',
    until: new Date(1_800_000_060_000),
    createdAt: new Date(1_800_000_000_000),
  });
});
