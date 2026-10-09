import { expect, test } from 'bun:test';
import { planLogRead, readLogBounds } from './plan-log-read';

test('#readLogBounds runs from the start of the first segment to the end of the last', () => {
  expect(
    readLogBounds(
      [
        { start: 100, length: 50 },
        { start: 200, length: 60 },
      ],
      0,
    ),
  ).toStrictEqual({ logStart: 100, logEnd: 260 });
});

test('#readLogBounds puts both bounds of an empty log at its origin', () => {
  expect(readLogBounds([], 42)).toStrictEqual({ logStart: 42, logEnd: 42 });
});

test('#planLogRead reads from the offset inside a segment up to that segment end', () => {
  expect(
    planLogRead(
      [
        { start: 100, length: 50 },
        { start: 200, length: 60 },
      ],
      0,
      120,
      1000,
    ),
  ).toStrictEqual({
    kind: 'read',
    offset: 120,
    gap: null,
    segment: { start: 100, length: 50 },
    skip: 20,
    length: 30,
    logStart: 100,
    logEnd: 260,
  });
});

test('#planLogRead reads no more than the limit', () => {
  expect(
    planLogRead(
      [
        { start: 100, length: 50 },
        { start: 200, length: 60 },
      ],
      0,
      210,
      5,
    ),
  ).toStrictEqual({
    kind: 'read',
    offset: 210,
    gap: null,
    segment: { start: 200, length: 60 },
    skip: 10,
    length: 5,
    logStart: 100,
    logEnd: 260,
  });
});

test('#planLogRead reports a gap before the first segment for a read below the log', () => {
  expect(
    planLogRead(
      [
        { start: 100, length: 50 },
        { start: 200, length: 60 },
      ],
      0,
      0,
      10,
    ),
  ).toStrictEqual({
    kind: 'read',
    offset: 100,
    gap: { from: 0, to: 100 },
    segment: { start: 100, length: 50 },
    skip: 0,
    length: 10,
    logStart: 100,
    logEnd: 260,
  });
});

test('#planLogRead reports a gap up to the next segment for a read in a hole', () => {
  expect(
    planLogRead(
      [
        { start: 100, length: 50 },
        { start: 200, length: 60 },
      ],
      0,
      160,
      1000,
    ),
  ).toStrictEqual({
    kind: 'read',
    offset: 200,
    gap: { from: 160, to: 200 },
    segment: { start: 200, length: 60 },
    skip: 0,
    length: 60,
    logStart: 100,
    logEnd: 260,
  });
});

test('#planLogRead reads nothing at the end of the log', () => {
  expect(
    planLogRead(
      [
        { start: 100, length: 50 },
        { start: 200, length: 60 },
      ],
      0,
      260,
      10,
    ),
  ).toStrictEqual({
    kind: 'read',
    offset: 260,
    gap: null,
    segment: null,
    skip: 0,
    length: 0,
    logStart: 100,
    logEnd: 260,
  });
});

test('#planLogRead refuses a read past the end of the log', () => {
  expect(
    planLogRead(
      [
        { start: 100, length: 50 },
        { start: 200, length: 60 },
      ],
      0,
      261,
      10,
    ),
  ).toStrictEqual({ kind: 'past_end', logStart: 100, logEnd: 260 });
});

test('#planLogRead reports a gap to the origin of an empty log that began past the read', () => {
  expect(planLogRead([], 300, 10, 10)).toStrictEqual({
    kind: 'read',
    offset: 300,
    gap: { from: 10, to: 300 },
    segment: null,
    skip: 0,
    length: 0,
    logStart: 300,
    logEnd: 300,
  });
});

test('#planLogRead refuses a read past the origin of an empty log', () => {
  expect(planLogRead([], 300, 301, 10)).toStrictEqual({
    kind: 'past_end',
    logStart: 300,
    logEnd: 300,
  });
});
