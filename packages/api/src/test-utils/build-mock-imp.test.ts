import { expect, test } from 'bun:test';
import { ImpSchema } from '../imp-schema';
import { buildMockImp } from './build-mock-imp';

test('it builds a default imp', () => {
  const imp = buildMockImp();
  const parsed: unknown = ImpSchema.safeParse(imp).data;
  const received: unknown = imp;

  expect(received).toStrictEqual({
    id: expect.any(String) as unknown,
    name: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    image: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    state: 'running',
    kind: 'user',
    vcpus: expect.any(Number) as unknown,
    memoryMib: expect.any(Number) as unknown,
    maxMemoryMib: expect.any(Number) as unknown,
    pluggedMib: expect.any(Number) as unknown,
    diskMib: expect.any(Number) as unknown,
    diskUsage: {
      exclusiveBytes: expect.any(Number) as unknown,
      sharedBytes: expect.any(Number) as unknown,
      measuredAt: expect.toBeValidDate() as unknown,
      isPartial: false,
      isUpperBound: false,
    },
    ip: expect.any(String) as unknown,
    slot: expect.any(Number) as unknown,
    port: expect.any(Number) as unknown,
    httpPort: expect.any(Number) as unknown,
    url: expect.any(String) as unknown,
    public: { auth: 'token' },
    createdAt: expect.toBeBefore(new Date('2026-01-01T00:00:00.000Z')) as unknown,
    lastActiveAt: expect.toBeValidDate() as unknown,
    ramMib: expect.any(Number) as unknown,
    rssMib: expect.any(Number) as unknown,
    sleptAt: expect.toBeValidDate() as unknown,
    holdUntil: expect.toBeValidDate() as unknown,
    leases: { leases: [], otherCount: 0 },
    error: expect.any(String) as unknown,
    sessions: expect.any(Number) as unknown,
    coldBootReason: expect.any(String) as unknown,
    agentSilentSince: expect.toBeValidDate() as unknown,
    outdated: [],
    cpu: { limit: null, weight: 100 },
    resources: { wakeCount: expect.any(Number) as unknown, awakeMs: expect.any(Number) as unknown },
    move: 'sending',
  });

  expect(parsed).toStrictEqual(imp);
  expect(imp.lastActiveAt).not.toBeBefore(imp.createdAt);
});

test('it applies overrides on top of the defaults', () => {
  const imp: unknown = buildMockImp({
    name: 'dev-b',
    state: 'sleeping',
    vcpus: 2,
    cpu: { limit: 1.5 },
  });

  expect(imp).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'dev-b',
    image: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    state: 'sleeping',
    kind: 'user',
    vcpus: 2,
    memoryMib: expect.any(Number) as unknown,
    maxMemoryMib: expect.any(Number) as unknown,
    pluggedMib: expect.any(Number) as unknown,
    diskMib: expect.any(Number) as unknown,
    diskUsage: {
      exclusiveBytes: expect.any(Number) as unknown,
      sharedBytes: expect.any(Number) as unknown,
      measuredAt: expect.toBeValidDate() as unknown,
      isPartial: false,
      isUpperBound: false,
    },
    ip: expect.any(String) as unknown,
    slot: expect.any(Number) as unknown,
    port: expect.any(Number) as unknown,
    httpPort: expect.any(Number) as unknown,
    url: expect.any(String) as unknown,
    public: { auth: 'token' },
    createdAt: expect.toBeBefore(new Date('2026-01-01T00:00:00.000Z')) as unknown,
    lastActiveAt: expect.toBeValidDate() as unknown,
    ramMib: expect.any(Number) as unknown,
    rssMib: expect.any(Number) as unknown,
    sleptAt: expect.toBeValidDate() as unknown,
    holdUntil: expect.toBeValidDate() as unknown,
    leases: { leases: [], otherCount: 0 },
    error: expect.any(String) as unknown,
    sessions: expect.any(Number) as unknown,
    coldBootReason: expect.any(String) as unknown,
    agentSilentSince: expect.toBeValidDate() as unknown,
    outdated: [],
    cpu: { limit: 1.5, weight: 100 },
    resources: { wakeCount: expect.any(Number) as unknown, awakeMs: expect.any(Number) as unknown },
    move: 'sending',
  });
});
