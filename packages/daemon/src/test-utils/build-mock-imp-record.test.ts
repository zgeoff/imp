import { expect, test } from 'bun:test';
import { isIPv4 } from 'node:net';
import { buildMockImpRecord } from './build-mock-imp-record';

test('it builds a default imp record', () => {
  expect(buildMockImpRecord()).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toSatisfy((name: string) => /^[a-z0-9]{12}$/v.test(name)),
    imageId: expect.toBeString(),
    state: 'running',
    kind: 'user',
    vcpus: expect.toBeWithin(1, 9),
    memoryMib: expect.toBeWithin(256, 8193),
    maxMemoryMib: expect.toBeWithin(256, 8193),
    slot: expect.toBeWithin(0, 4096),
    ip: expect.toSatisfy(isIPv4),
    createdAt: expect.toBeValidDate(),
    lastActiveAt: expect.toBeValidDate(),
    sleptAt: null,
    holdUntil: null,
    error: null,
    pid: expect.toBeWithin(2, 4_194_305),
    firecrackerVersion: 'v1.17.0',
    httpPort: expect.toBeWithin(0, 65_536),
    diskBytes: expect.toBeWithin(1024 ** 3, 64 * 1024 ** 3 + 1),
    isDiskGrowPending: false,
    publicAuth: null,
    cpu: { limit: null, weight: 100 },
    wakeCount: expect.toBeWithin(0, 101),
    jailUid: expect.toBeWithin(900_000, 965_536),
    awakeMs: expect.toBeWithin(0, 86_400_001),
    awakeSince: expect.toBeValidDate(),
    isIdentityResetPending: false,
    isTrustPending: false,
    moveState: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  const imp = buildMockImpRecord({ name: 'dev', state: 'sleeping', pid: null, moveState: 'moved' });

  expect(imp).toMatchObject({ name: 'dev', state: 'sleeping', pid: null, moveState: 'moved' });
});

test('it grows to its own memory by default', () => {
  const imp = buildMockImpRecord();

  expect(imp.maxMemoryMib).toBe(imp.memoryMib);
});
