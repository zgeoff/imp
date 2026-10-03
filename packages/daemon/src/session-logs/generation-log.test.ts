import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORPCError } from '@orpc/server';
import {
  createGenerationLog as createLog,
  findSegmentPath,
  loadGenerationLog as loadLog,
  readGenerationBounds,
  readGenerationMeta,
} from './generation-log';
import type { GenerationLog, GenerationLogOptions, GenerationMeta } from './generation-log';

const GENERATION = 'a'.repeat(32);
const dirs: string[] = [];

// each test's logs: their open files close before the directories go
const logs: GenerationLog[] = [];

afterEach(() => {
  for (const log of logs.splice(0)) {
    log.abandon();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setupOptions(overrides: Partial<GenerationLogOptions> = {}): GenerationLogOptions {
  const root = mkdtempSync(join(tmpdir(), 'imp-generation-log-'));

  dirs.push(root);

  return {
    dir: join(root, GENERATION),
    segmentBytes: 10,
    maxBytes: 20,
    requireRoom: () => Promise.resolve(),
    now: () => 1000,
    log: () => {},
    ...overrides,
  };
}

async function createGenerationLog(
  options: GenerationLogOptions,
  identity: Readonly<typeof IDENTITY>,
) {
  const log = await createLog(options, identity);

  logs.push(log);

  return log;
}

async function loadGenerationLog(options: GenerationLogOptions, meta: GenerationMeta) {
  const log = await loadLog(options, meta);

  logs.push(log);

  return log;
}

const IDENTITY = { session: 'main', executionGeneration: GENERATION, bootId: 'boot-1' };

function readSegment(dir: string, start: number): string {
  return readFileSync(findSegmentPath(dir, start), 'utf8');
}

test('appends fill segments and the oldest go past the bound', async () => {
  const options = setupOptions();

  const log = await createGenerationLog(options, IDENTITY);

  await log.append(new TextEncoder().encode('0123456789abcdefghijKLMNO'));
  await log.commit();

  // 25 bytes in segments of 10, at most 20 kept: [10, 20) and [20, 25)
  const meta = readGenerationMeta(options.dir);

  expect(meta?.segments).toEqual([
    { start: 10, length: 10 },
    { start: 20, length: 5 },
  ]);

  expect(readSegment(options.dir, 10)).toBe('abcdefghij');
  expect(readSegment(options.dir, 20)).toBe('KLMNO');
  expect(readdirSync(options.dir).toSorted()).toEqual(['10.seg', '20.seg', 'meta.json']);
});

test('a skip starts a new segment past a hole, and an empty log moves its origin', async () => {
  const options = setupOptions({ segmentBytes: 100, maxBytes: 200 });

  const log = await createGenerationLog(options, IDENTITY);

  log.skipTo(500);

  await log.append(new TextEncoder().encode('abc'));

  log.skipTo(900);

  await log.append(new TextEncoder().encode('xyz'));

  expect(log.readMeta().segments).toEqual([
    { start: 500, length: 3 },
    { start: 900, length: 3 },
  ]);

  expect(readGenerationBounds(log.readMeta())).toEqual({ logStart: 500, logEnd: 903 });
});

test('a reload cuts a torn tail back to what the meta counted', async () => {
  const options = setupOptions({ segmentBytes: 100, maxBytes: 200 });

  const log = await createGenerationLog(options, IDENTITY);

  await log.append(new TextEncoder().encode('counted'));
  await log.commit();

  // after the commit: bytes the meta never counted, as a crash leaves them,
  // and a segment it never named
  appendFileSync(findSegmentPath(options.dir, 0), '\0\0garbage');
  appendFileSync(findSegmentPath(options.dir, 7), 'stray');

  log.abandon();

  const meta = readGenerationMeta(options.dir);

  expect(meta?.segments).toEqual([{ start: 0, length: 7 }]);

  if (meta === null) {
    throw new Error('no meta');
  }

  const reopened = await loadGenerationLog(options, meta);

  expect(readSegment(options.dir, 0)).toBe('counted');
  expect(readdirSync(options.dir).toSorted()).toEqual(['0.seg', 'meta.json']);

  // the reopened log goes on in a new segment at its end
  await reopened.append(new TextEncoder().encode('+more'));
  await reopened.commit();

  expect(readSegment(options.dir, 7)).toBe('+more');
  expect(readGenerationBounds(reopened.readMeta())).toEqual({ logStart: 0, logEnd: 12 });
});

test('finish records the end and the exit, and later output is not kept', async () => {
  const options = setupOptions({ segmentBytes: 100, maxBytes: 200 });

  const log = await createGenerationLog(options, IDENTITY);

  await log.append(new TextEncoder().encode('bye'));
  await log.finish({ end: 3, exitCode: 0 });
  await log.append(new TextEncoder().encode('late'));

  expect(readGenerationMeta(options.dir)).toMatchObject({
    state: 'ended',
    end: 3,
    exitCode: 0,
    endedAt: 1000,
    segments: [{ start: 0, length: 3 }],
  });
});

test('a full disk refuses the next segment, and the log stops', async () => {
  const full = new ORPCError('DISK_FULL', { message: 'full' });

  const room = { left: 1 };

  const options = setupOptions({
    requireRoom: () => {
      room.left -= 1;

      return room.left < 0 ? Promise.reject(full) : Promise.resolve();
    },
  });

  const log = await createGenerationLog(options, IDENTITY);

  await log.append(new TextEncoder().encode('0123456789'));

  const refused = await log
    .append(new TextEncoder().encode('more'))
    .catch((error: unknown) => error);

  expect(refused).toBe(full);

  await log.stop('disk_full');

  expect(readGenerationMeta(options.dir)).toMatchObject({
    state: 'live',
    stopped: 'disk_full',
    segments: [{ start: 0, length: 10 }],
  });
});

test('removeOldestSegment keeps the last one', async () => {
  const options = setupOptions({ segmentBytes: 4, maxBytes: 100 });

  const log = await createGenerationLog(options, IDENTITY);

  await log.append(new TextEncoder().encode('aaaabbbb'));

  const first = await log.removeOldestSegment();
  const second = await log.removeOldestSegment();

  expect(first).toBe(true);
  expect(second).toBe(false);
  expect(readGenerationMeta(options.dir)?.segments).toEqual([{ start: 4, length: 4 }]);
});
