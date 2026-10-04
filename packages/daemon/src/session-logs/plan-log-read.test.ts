import { expect, test } from 'bun:test';
import { planLogRead, readLogBounds } from './plan-log-read';

// [100, 150) and [200, 260): the oldest 100 bytes went, and a tap gap left
// [150, 200) out
const SEGMENTS = [
  { start: 100, length: 50 },
  { start: 200, length: 60 },
];

test('the bounds run from the first segment to the end of the last', () => {
  expect(readLogBounds(SEGMENTS, 0)).toEqual({ logStart: 100, logEnd: 260 });
  expect(readLogBounds([], 42)).toEqual({ logStart: 42, logEnd: 42 });
});

test('a read inside a segment is exact and stops at its end', () => {
  expect(planLogRead(SEGMENTS, 0, 120, 1000)).toMatchObject({
    kind: 'read',
    offset: 120,
    gap: null,
    segment: SEGMENTS[0],
    skip: 20,
    length: 30,
  });

  expect(planLogRead(SEGMENTS, 0, 210, 5)).toMatchObject({ offset: 210, skip: 10, length: 5 });
});

test('a read below the log, or in a hole, is a gap before the data', () => {
  expect(planLogRead(SEGMENTS, 0, 0, 10)).toMatchObject({
    offset: 100,
    gap: { from: 0, to: 100 },
    skip: 0,
    length: 10,
  });

  expect(planLogRead(SEGMENTS, 0, 160, 1000)).toMatchObject({
    offset: 200,
    gap: { from: 160, to: 200 },
    segment: SEGMENTS[1],
    length: 60,
  });
});

test('a read at the end gets nothing, and past it is refused', () => {
  expect(planLogRead(SEGMENTS, 0, 260, 10)).toMatchObject({
    kind: 'read',
    offset: 260,
    gap: null,
    segment: null,
    length: 0,
  });

  expect(planLogRead(SEGMENTS, 0, 261, 10)).toEqual({
    kind: 'past_end',
    logStart: 100,
    logEnd: 260,
  });
});

test('an empty log that began past the read is a gap to its origin', () => {
  expect(planLogRead([], 300, 10, 10)).toMatchObject({
    offset: 300,
    gap: { from: 10, to: 300 },
    length: 0,
  });

  expect(planLogRead([], 300, 301, 10).kind).toBe('past_end');
});
