import { expect, test } from 'bun:test';
import { MAX_LEASE_REMAINING_MS, MAX_MOVED_LEASES, MoveHeaderSchema } from './move-header';

const BOOT = {
  bootId: '00000000-0000-4000-8000-000000000001',
  cause: 'start',
  at: '2026-10-03T00:00:00.000Z',
};

// the smallest header a cold move sends, with `coldBoots` and, unless
// undefined, `leases`
function buildHeader(coldBoots: readonly unknown[], leases?: readonly unknown[]) {
  return {
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 1,
      memoryMib: 256,
      httpPort: 8080,
      diskBytes: 1024,
      cpu: { limit: null, weight: 100 },
      egress: { mode: 'open', allow: [] },
      grants: [],
      isIdentityResetPending: false,
      coldBoots,
      ...(leases !== undefined && { leases }),
    },
    image: {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
      source: 'oci',
      sourceImp: null,
      isIncluded: false,
    },
    checkpoints: [],
    streams: null,
  };
}

test('a header carries at most 4 cold boots, each with a UUID boot id and a known cause', () => {
  const valid = MoveHeaderSchema.safeParse(buildHeader([BOOT]));
  const tooMany = MoveHeaderSchema.safeParse(buildHeader(Array.from({ length: 5 }, () => BOOT)));
  const notUuid = MoveHeaderSchema.safeParse(buildHeader([{ ...BOOT, bootId: '../x' }]));
  const badCause = MoveHeaderSchema.safeParse(buildHeader([{ ...BOOT, cause: 'magic' }]));

  expect(valid.success).toBe(true);
  expect([tooMany.success, notUuid.success, badCause.success]).toEqual([false, false, false]);
});

const LEASE = {
  principal: 'tailnet:n1',
  label: 'job',
  display: 'laptop',
  remainingMs: 60_000,
  createdAt: '2026-10-03T00:00:00.000Z',
};

test('a header from a source before leases moved parses with no leases', () => {
  const header = MoveHeaderSchema.parse(buildHeader([]));

  expect(header.imp.leases).toBeUndefined();
});

// a lease with these fields changed, alone in a header
function parseWithLease(fields: Readonly<Record<string, unknown>>): boolean {
  return MoveHeaderSchema.safeParse(buildHeader([], [{ ...LEASE, ...fields }])).success;
}

test('a header bounds its leases: their count, their time left, and the owner and label', () => {
  const tooMany = Array.from({ length: MAX_MOVED_LEASES + 1 }, () => LEASE);
  const long = 'x'.repeat(257);

  const refused = [
    { remainingMs: -1 },
    { remainingMs: 1.5 },
    { remainingMs: MAX_LEASE_REMAINING_MS + 1 },
    { label: 'a b' },
    { label: 'x'.repeat(65) },
    { principal: '' },
    { principal: long },
    { display: long },
  ];

  expect(parseWithLease({})).toBe(true);
  expect(parseWithLease({ label: 'hold', remainingMs: null })).toBe(true);
  expect(parseWithLease({ remainingMs: MAX_LEASE_REMAINING_MS })).toBe(true);
  expect(MoveHeaderSchema.safeParse(buildHeader([], tooMany)).success).toBe(false);
  expect(refused.filter((fields) => parseWithLease(fields))).toEqual([]);
});
