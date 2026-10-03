import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, open, rename, stat, truncate, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { readLogBounds } from './plan-log-read';
import type { LogBounds, LogSegment } from './plan-log-read';

// One generation's log (docs/architecture/daemon.md#session-logs): segment
// files, `<start>.seg`, and `meta.json`, which counts the bytes of each that
// reached the disk first. A torn tail past that count is never read.

const META_FILE = 'meta.json';
const SEGMENT_SUFFIX = '.seg';

// the most a host crash loses of a tapped session's output
const COMMIT_DELAY_MS = 1000;
const OffsetSchema = z.int().nonnegative();

const GenerationMetaSchema = z.object({
  version: z.literal(1),
  session: z.string(),
  executionGeneration: z.string(),
  bootId: z.string(),
  startedAt: z.int(),

  // where the log began while it holds no segment
  origin: OffsetSchema,
  segments: z.array(z.object({ start: OffsetSchema, length: OffsetSchema })),
  state: z.enum(['live', 'ended']),

  // once ended: when; and the final end and exit code (null for a signal)
  // when impd saw the exit, not when the VM went first
  endedAt: z.int().optional(),
  end: OffsetSchema.optional(),
  exitCode: z.int().nullable().optional(),

  // logging stopped before the generation ended
  stopped: z.literal('disk_full').optional(),
});

type StoredMeta = z.infer<typeof GenerationMetaSchema>;

export type GenerationMeta = Readonly<Omit<StoredMeta, 'segments'>> & {
  readonly segments: readonly LogSegment[];
};

export interface GenerationEnd {
  readonly end?: number;
  readonly exitCode?: number | null;
}

export interface GenerationLog {
  // the meta with live segment lengths: what a read on this host may see,
  // since every counted byte is in the page cache
  readonly readMeta: () => GenerationMeta;

  // where an empty log starts, before its first byte
  readonly setOrigin: (offset: number) => void;

  // appends output that starts at the log's end
  readonly append: (data: Uint8Array) => Promise<void>;

  // the tap skipped to `offset`: the next byte starts a new segment there
  readonly skipTo: (offset: number) => void;

  // false when no segment could go: one is always kept
  readonly removeOldestSegment: () => Promise<boolean>;
  readonly finish: (end: Readonly<GenerationEnd>) => Promise<void>;
  readonly stop: (reason: 'disk_full') => Promise<void>;

  // flushes what was appended now, not at the next commit
  readonly commit: () => Promise<void>;

  // stops writing and drops what is pending: the directory is about to go
  readonly abandon: () => void;
}

export interface GenerationLogOptions {
  readonly dir: string;

  // a log keeps at most maxBytes of segments of segmentBytes each, so at
  // least maxBytes less one segment of its newest output
  readonly segmentBytes: number;
  readonly maxBytes: number;

  // throws DISK_FULL when a new segment would reach the host's reserve
  readonly requireRoom: (bytes: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

type MetaChange = Readonly<Partial<Omit<StoredMeta, 'segments'>>>;

export function findSegmentPath(dir: string, start: number): string {
  return join(dir, `${String(start)}${SEGMENT_SUFFIX}`);
}

// The meta as written; null for a directory without a readable one.
export function readGenerationMeta(dir: string): GenerationMeta | null {
  const path = join(dir, META_FILE);

  if (!existsSync(path)) {
    return null;
  }

  try {
    return GenerationMetaSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function countLogBytes(meta: GenerationMeta): number {
  return meta.segments.reduce((sum, segment) => sum + segment.length, 0);
}

export function readGenerationBounds(meta: GenerationMeta): LogBounds {
  return readLogBounds(meta.segments, meta.origin);
}

// A new log for a generation impd has not logged before.
export async function createGenerationLog(
  options: GenerationLogOptions,
  identity: Readonly<Pick<StoredMeta, 'session' | 'executionGeneration' | 'bootId'>>,
): Promise<GenerationLog> {
  await mkdir(options.dir, { recursive: true, mode: 0o700 });

  const log = buildGenerationLog(options, {
    version: 1,
    ...identity,
    startedAt: options.now(),
    origin: 0,
    segments: [],
    state: 'live',
  });

  await log.commit();

  return log;
}

// Reopens a live log an earlier impd wrote: each segment is cut to its
// count, and files the meta does not name go.
export async function loadGenerationLog(
  options: GenerationLogOptions,
  meta: GenerationMeta,
): Promise<GenerationLog> {
  const kept: LogSegment[] = [];

  for (const segment of meta.segments) {
    const path = findSegmentPath(options.dir, segment.start);

    const size = await readFileSize(path);

    if (size === null) {
      continue;
    }

    // a file shorter than its count lost bytes after their flush: keep what
    // is there
    const length = Math.min(size, segment.length);

    if (size > length) {
      await truncate(path, length);
    }

    kept.push({ start: segment.start, length });
  }

  const named = new Set(kept.map((segment) => `${String(segment.start)}${SEGMENT_SUFFIX}`));

  for (const file of readdirSync(options.dir)) {
    if (file !== META_FILE && !named.has(file)) {
      rmSync(join(options.dir, file), { force: true });
    }
  }

  const log = buildGenerationLog(options, { ...meta, segments: kept });

  await log.commit();

  return log;
}

async function readFileSize(path: string): Promise<number | null> {
  try {
    const stats = await stat(path);

    return stats.size;
  } catch {
    return null;
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // gone already
  }
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- a live file handle
async function stopQuietly(file: FileHandle): Promise<void> {
  try {
    await file.close();
  } catch {
    // the log is being abandoned
  }
}

function setNothingDone(): void {
  // replaced before the first wait
}

// the meta's own text: written next to it, flushed, renamed over it
async function writeMetaFile(dir: string, meta: GenerationMeta): Promise<void> {
  const path = join(dir, META_FILE);
  const next = `${path}.new`;

  const file = await open(next, 'w', 0o600);

  try {
    await file.writeFile(JSON.stringify(meta));
    await file.datasync();
  } finally {
    await file.close();
  }

  await rename(next, path);

  const directory = await open(dir, 'r');

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function buildGenerationLog(options: GenerationLogOptions, initial: GenerationMeta): GenerationLog {
  const meta: StoredMeta = {
    ...initial,
    segments: initial.segments.map((segment) => ({ ...segment })),
  };

  const state = {
    file: null as FileHandle | null,

    // the meta's entry for the segment the open file writes
    current: null as StoredMeta['segments'][number] | null,
    skipTo: null as number | null,
    timer: null as ReturnType<typeof setTimeout> | null,

    // set once the log finished or stopped: later output is not kept
    settled: initial.state === 'ended' || initial.stopped !== undefined,
    abandoned: false,
  };

  // every write waits for the one before it
  let chain: Promise<void> = Promise.resolve();

  const runInOrder = async <T>(task: () => Promise<T>, fallback: T): Promise<T> => {
    const before = chain;
    let setDone = setNothingDone;

    chain = new Promise<void>((resolve) => {
      setDone = resolve;
    });

    try {
      await before;

      return state.abandoned ? fallback : await task();
    } finally {
      setDone();
    }
  };

  const readEnd = (): number => readLogBounds(meta.segments, meta.origin).logEnd;

  const stopFile = async (): Promise<void> => {
    const file = state.file;

    state.file = null;
    state.current = null;

    if (file !== null) {
      await file.datasync();
      await file.close();
    }
  };

  // the bytes reach the disk before the meta that counts them
  const writeMeta = async (): Promise<void> => {
    await state.file?.datasync();

    await writeMetaFile(options.dir, meta);
  };

  const runCommit = async (): Promise<void> => {
    try {
      await runInOrder(writeMeta, undefined);
    } catch (error) {
      options.log(`impd: session log ${options.dir}: ${String(error)}`);
    }
  };

  const startCommitTimer = (): void => {
    if (state.timer !== null) {
      return;
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      void runCommit();
    }, COMMIT_DELAY_MS);

    state.timer.unref();
  };

  const stopCommitTimer = (): void => {
    if (state.timer !== null) {
      clearTimeout(state.timer);

      state.timer = null;
    }
  };

  const removeOldest = async (): Promise<boolean> => {
    const [oldest] = meta.segments;

    if (oldest === undefined || meta.segments.length < 2) {
      return false;
    }

    meta.segments.shift();

    await writeMeta();
    await removeQuietly(findSegmentPath(options.dir, oldest.start));

    return true;
  };

  const startSegment = async (start: number): Promise<void> => {
    await stopFile();

    await options.requireRoom(options.segmentBytes);

    const path = findSegmentPath(options.dir, start);

    // a file the meta never counted is a crash's leftover
    await removeQuietly(path);

    state.file = await open(path, 'wx', 0o600);

    state.current = { start, length: 0 };

    meta.segments.push(state.current);

    while (countLogBytes(meta) + options.segmentBytes > options.maxBytes) {
      if (!(await removeOldest())) {
        break;
      }
    }
  };

  const writeBytes = async (data: Uint8Array): Promise<void> => {
    if (state.settled) {
      return;
    }

    let rest = data;

    while (rest.byteLength > 0) {
      const current = state.current;
      const file = state.file;

      if (
        current === null ||
        file === null ||
        state.skipTo !== null ||
        current.length >= options.segmentBytes
      ) {
        await startSegment(state.skipTo ?? readEnd());

        state.skipTo = null;
        continue;
      }

      const piece = rest.subarray(0, options.segmentBytes - current.length);

      await file.write(piece, 0, piece.byteLength, current.length);

      current.length += piece.byteLength;
      rest = rest.subarray(piece.byteLength);
    }

    startCommitTimer();
  };

  const writeSettled = async (change: MetaChange): Promise<void> => {
    stopCommitTimer();

    state.settled = true;

    Object.assign(meta, change);

    await writeMeta();
    await stopFile();
  };

  return {
    readMeta: () => ({ ...meta, segments: meta.segments.map((segment) => ({ ...segment })) }),
    setOrigin: (offset) => {
      if (meta.segments.length === 0) {
        meta.origin = offset;
      }
    },
    append: (data) => runInOrder(() => writeBytes(data), undefined),
    skipTo: (offset) => {
      if (meta.segments.length === 0) {
        meta.origin = offset;

        return;
      }

      state.skipTo = offset;
    },
    removeOldestSegment: () => runInOrder(removeOldest, false),
    finish: (end) =>
      runInOrder(async () => {
        if (meta.state === 'ended') {
          return;
        }

        await writeSettled({
          state: 'ended',
          endedAt: options.now(),
          ...(end.end !== undefined && { end: end.end }),
          ...(end.exitCode !== undefined && { exitCode: end.exitCode }),
        });
      }, undefined),
    stop: (reason) => runInOrder(() => writeSettled({ stopped: reason }), undefined),
    commit: () => runInOrder(writeMeta, undefined),
    abandon: () => {
      state.abandoned = true;

      stopCommitTimer();

      if (state.file !== null) {
        void stopQuietly(state.file);
        state.file = null;
      }
    },
  };
}
