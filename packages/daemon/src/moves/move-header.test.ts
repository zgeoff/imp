import { expect, test } from 'bun:test';
import { MoveHeaderSchema } from './move-header';

const BOOT = {
  bootId: '00000000-0000-4000-8000-000000000001',
  cause: 'start',
  at: '2026-10-03T00:00:00.000Z',
};

// the smallest header a cold move sends, with `coldBoots`
function buildHeader(coldBoots: readonly unknown[]) {
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
