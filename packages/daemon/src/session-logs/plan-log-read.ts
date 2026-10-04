// The bytes at offsets [start, start + length), in the file named by start;
// a log's segments are in order, and a gap in the tap leaves a hole.
export interface LogSegment {
  readonly start: number;
  readonly length: number;
}

export interface LogBounds {
  // the oldest byte the log holds, and the offset after its last
  readonly logStart: number;
  readonly logEnd: number;
}

export type LogReadPlan =
  | ({ readonly kind: 'past_end' } & LogBounds)
  | ({
      readonly kind: 'read';

      // the offset of the first byte read; past `from` after a gap
      readonly offset: number;

      // the bytes [from, offset) the log does not hold
      readonly gap: { readonly from: number; readonly to: number } | null;

      // the segment read from, `skip` bytes into it; null reads nothing
      readonly segment: LogSegment | null;
      readonly skip: number;
      readonly length: number;
    } & LogBounds);

// The bounds of a log; `origin` is where an empty log began.
export function readLogBounds(segments: readonly LogSegment[], origin: number): LogBounds {
  const [first] = segments;
  const last = segments.at(-1);

  return {
    logStart: first?.start ?? origin,
    logEnd: last === undefined ? origin : last.start + last.length,
  };
}

// Where a read from `from` lands, with the ring's rules: lost bytes are a
// gap before the data, and past the end is a client bug. A read stays in one
// segment; the client reads on from the offset after its data.
export function planLogRead(
  segments: readonly LogSegment[],
  origin: number,
  from: number,
  limit: number,
): LogReadPlan {
  const bounds = readLogBounds(segments, origin);

  if (from > bounds.logEnd) {
    return { kind: 'past_end', ...bounds };
  }

  const segment = segments.find((each) => each.start + each.length > from);

  if (segment === undefined) {
    // at the end: nothing to read, though an empty log may start past `from`
    const gap = from < bounds.logStart ? { from, to: bounds.logStart } : null;

    return {
      kind: 'read',
      offset: gap?.to ?? from,
      gap,
      segment: null,
      skip: 0,
      length: 0,
      ...bounds,
    };
  }

  const offset = Math.max(from, segment.start);

  return {
    kind: 'read',
    offset,
    gap: offset > from ? { from, to: offset } : null,
    segment,
    skip: offset - segment.start,
    length: Math.min(limit, segment.start + segment.length - offset),
    ...bounds,
  };
}
