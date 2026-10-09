import { expect, mock, onTestFinished, test } from 'bun:test';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/server';
import { buildStubTimers } from '../test-utils/build-stub-timers';
import {
  createGenerationLog,
  loadGenerationLog,
  readGenerationBounds,
  readGenerationMeta,
} from './generation-log';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const root = await mkdtemp(join(tmpdir(), 'imp-generation-log-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  // the log's own directory, which making the log creates
  return { stack, dir: join(root, 'a'.repeat(32)) };
}

test('it keeps appended output in segments and drops the oldest past the bound', async () => {
  const ctx = await setupTest();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 10,
      maxBytes: 20,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  // 25 bytes in segments of 10, at most 20 kept: [10, 20) and [20, 25)
  await log.append(new TextEncoder().encode('0123456789abcdefghijKLMNO'));
  await log.commit();

  expect(readGenerationMeta(ctx.dir)?.segments).toStrictEqual([
    { start: 10, length: 10 },
    { start: 20, length: 5 },
  ]);

  expect(readFileSync(join(ctx.dir, '10.seg'), 'utf8')).toBe('abcdefghij');
  expect(readFileSync(join(ctx.dir, '20.seg'), 'utf8')).toBe('KLMNO');
  expect(readdirSync(ctx.dir).toSorted()).toStrictEqual(['10.seg', '20.seg', 'meta.json']);
});

test('it starts each offset a skip names as a new segment', async () => {
  const ctx = await setupTest();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  // the first skip moves an empty log's origin; the second leaves a hole
  log.skipTo(500);

  await log.append(new TextEncoder().encode('abc'));

  log.skipTo(900);

  await log.append(new TextEncoder().encode('xyz'));

  expect(log.readMeta().segments).toStrictEqual([
    { start: 500, length: 3 },
    { start: 900, length: 3 },
  ]);

  expect(readGenerationBounds(log.readMeta())).toStrictEqual({ logStart: 500, logEnd: 903 });
});

test('it cuts a torn tail back to what the meta counted when it loads a log', async () => {
  const ctx = await setupTest();

  const written = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    written.abandon();
  });

  await written.append(new TextEncoder().encode('counted'));
  await written.commit();

  // after the commit: bytes the meta never counted, as a crash leaves them,
  // and a segment it never named
  appendFileSync(join(ctx.dir, '0.seg'), '\0\0garbage');
  appendFileSync(join(ctx.dir, '7.seg'), 'stray');

  written.abandon();

  const meta = readGenerationMeta(ctx.dir);

  invariant(meta);

  const reopened = await loadGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    meta,
  );

  ctx.stack.defer(() => {
    reopened.abandon();
  });

  expect(reopened.readMeta().segments).toStrictEqual([{ start: 0, length: 7 }]);
  expect(readFileSync(join(ctx.dir, '0.seg'), 'utf8')).toBe('counted');
  expect(readdirSync(ctx.dir).toSorted()).toStrictEqual(['0.seg', 'meta.json']);
});

test('it goes on in a new segment at the end of a loaded log', async () => {
  const ctx = await setupTest();

  const written = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    written.abandon();
  });

  await written.append(new TextEncoder().encode('counted'));
  await written.commit();

  written.abandon();

  const meta = readGenerationMeta(ctx.dir);

  invariant(meta);

  const reopened = await loadGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    meta,
  );

  ctx.stack.defer(() => {
    reopened.abandon();
  });

  await reopened.append(new TextEncoder().encode('+more'));
  await reopened.commit();

  expect(readFileSync(join(ctx.dir, '7.seg'), 'utf8')).toBe('+more');
  expect(readGenerationBounds(reopened.readMeta())).toStrictEqual({ logStart: 0, logEnd: 12 });
});

test('it records the end, the exit code and the end time when the log finishes', async () => {
  const ctx = await setupTest();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('bye'));
  await log.finish({ end: 3, exitCode: 0 });

  expect(readGenerationMeta(ctx.dir)).toStrictEqual({
    version: 1,
    session: 'main',
    executionGeneration: 'a'.repeat(32),
    bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    startedAt: 1000,
    origin: 0,
    segments: [{ start: 0, length: 3 }],
    state: 'ended',
    endedAt: 1000,
    end: 3,
    exitCode: 0,
  });
});

test('it keeps no output that comes after the log finished', async () => {
  const ctx = await setupTest();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('bye'));
  await log.finish({ end: 3, exitCode: 0 });
  await log.append(new TextEncoder().encode('late'));

  expect(readGenerationMeta(ctx.dir)?.segments).toStrictEqual([{ start: 0, length: 3 }]);
  expect(readFileSync(join(ctx.dir, '0.seg'), 'utf8')).toBe('bye');
});

test('it rejects an append whose new segment would reach the disk reserve', async () => {
  const ctx = await setupTest();

  const full = new ORPCError('DISK_FULL', { message: 'full' });

  // room for the first segment only
  const room = { left: 1 };

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 10,
      maxBytes: 20,
      requireRoom: () => {
        room.left -= 1;

        return room.left < 0 ? Promise.reject(full) : Promise.resolve();
      },
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('0123456789'));

  expect(log.append(new TextEncoder().encode('more'))).rejects.toBe(full);
});

test('it records the stop and keeps the written segments when the log stops for a full disk', async () => {
  const ctx = await setupTest();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 10,
      maxBytes: 20,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('0123456789'));
  await log.stop('disk_full');

  expect(readGenerationMeta(ctx.dir)).toStrictEqual({
    version: 1,
    session: 'main',
    executionGeneration: 'a'.repeat(32),
    bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    startedAt: 1000,
    origin: 0,
    segments: [{ start: 0, length: 10 }],
    state: 'live',
    stopped: 'disk_full',
  });
});

test('it removes the oldest segment and its file', async () => {
  const ctx = await setupTest();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 4,
      maxBytes: 100,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('aaaabbbb'));

  const isRemoved = await log.removeOldestSegment();

  expect(isRemoved).toBe(true);
  expect(readGenerationMeta(ctx.dir)?.segments).toStrictEqual([{ start: 4, length: 4 }]);
  expect(existsSync(join(ctx.dir, '0.seg'))).toBe(false);
});

test('it keeps the last segment when asked to remove the oldest', async () => {
  const ctx = await setupTest();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 4,
      maxBytes: 100,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('aaaa'));

  const isRemoved = await log.removeOldestSegment();

  expect(isRemoved).toBe(false);
  expect(log.readMeta().segments).toStrictEqual([{ start: 0, length: 4 }]);
});

test('it starts a commit one second after an append', async () => {
  const ctx = await setupTest();

  const timers = buildStubTimers();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
      startTimer: timers.startTimer,
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('abc'));

  expect(timers.readPendingMs()).toStrictEqual([1000]);
  expect(readGenerationMeta(ctx.dir)?.segments).toStrictEqual([]);
});

test('it writes the appended bytes into the meta when the commit timer fires', async () => {
  const ctx = await setupTest();

  const timers = buildStubTimers();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
      startTimer: timers.startTimer,
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('abc'));

  timers.firePending();

  await waitFor(() => {
    expect(readGenerationMeta(ctx.dir)?.segments).toStrictEqual([{ start: 0, length: 3 }]);
  });
});

test('it cancels the pending commit when the log is abandoned', async () => {
  const ctx = await setupTest();

  const timers = buildStubTimers();

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
      startTimer: timers.startTimer,
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('abc'));

  log.abandon();

  expect(timers.readPendingMs()).toStrictEqual([]);
});

test('it rejects an append whose segment opened while the log was abandoned', async () => {
  const ctx = await setupTest();

  const room = Promise.withResolvers<undefined>();
  const requireRoom = mock(() => room.promise);

  const log = await createGenerationLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom,
      now: () => 1000,
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    log.abandon();
  });

  // the append waits for room for its first segment while the log is abandoned
  const appending = log.append(new TextEncoder().encode('abc'));

  await waitFor(() => {
    expect(requireRoom).toHaveBeenCalledOnce();
  });

  log.abandon();
  room.resolve(undefined);

  expect(appending).rejects.toThrowWithMessage(Error, 'session log: abandoned');
});
