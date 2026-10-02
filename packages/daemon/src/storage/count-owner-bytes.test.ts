import { expect, test } from 'bun:test';
import { countOwnerBytes } from './count-owner-bytes';

const SHARED = 0x20_00;
const MIB = 1024 * 1024;

function buildExtent(physicalMib: number, lengthMib: number, flags = 0) {
  return { logical: 0, physical: physicalMib * MIB, length: lengthMib * MIB, flags };
}

test('an imp owns what only its files hold, and shares what an image or another imp holds', () => {
  const totals = countOwnerBytes([
    // the image: 100 MiB, which both disks clone
    { owner: 'image:base', extents: [buildExtent(0, 100, SHARED)] },

    // a: its own 10 MiB, the image's first 60 MiB, and a checkpoint that
    // shares a's own 10 MiB
    { owner: 'imp:a', extents: [buildExtent(0, 60, SHARED), buildExtent(500, 10, SHARED)] },
    { owner: 'imp:a', extents: [buildExtent(500, 10, SHARED)] },

    // b: the whole image, and 5 MiB written since
    { owner: 'imp:b', extents: [buildExtent(0, 100, SHARED), buildExtent(700, 5)] },
  ]);

  expect(Object.fromEntries(totals)).toEqual({
    'image:base': { exclusiveBytes: 0, sharedBytes: 100 * MIB },
    'imp:a': { exclusiveBytes: 10 * MIB, sharedBytes: 60 * MIB },
    'imp:b': { exclusiveBytes: 5 * MIB, sharedBytes: 100 * MIB },
  });
});

test('a shared extent another owner no longer holds is exclusive', () => {
  // FIEMAP marked it shared, but the other file is not one of the owners
  const totals = countOwnerBytes([{ owner: 'imp:a', extents: [buildExtent(0, 8, SHARED)] }]);

  expect(totals.get('imp:a')).toEqual({ exclusiveBytes: 8 * MIB, sharedBytes: 0 });
});
