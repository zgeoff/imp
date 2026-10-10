import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGenerationMeta } from '../session-logs/generation-log';
import { buildStubGenerationLogGate } from './build-stub-generation-log-gate';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'imp-log-gate-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return { dir: join(root, 'a'.repeat(32)) };
}

test('it holds the chosen making of a log until the test releases it', async () => {
  const ctx = await setupTest();

  const gate = buildStubGenerationLogGate({ operation: 'create', call: 1 });

  const making = gate.createLog(
    {
      dir: ctx.dir,
      segmentBytes: 10,
      maxBytes: 20,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    { session: 'main', executionGeneration: 'a'.repeat(32), bootId: '' },
  );

  await gate.reached;

  const whileHeld = Bun.peek.status(making);

  gate.release();

  const log = await making;

  onTestFinished(() => {
    log.abandon();
  });

  expect(whileHeld).toBe('pending');
  expect(readGenerationMeta(ctx.dir)?.executionGeneration).toBe('a'.repeat(32));
});

test('it lets the calls before the held one through and holds the chosen append', async () => {
  const ctx = await setupTest();

  const gate = buildStubGenerationLogGate({ operation: 'append', call: 2 });

  const log = await gate.createLog(
    {
      dir: ctx.dir,
      segmentBytes: 100,
      maxBytes: 200,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    { session: 'main', executionGeneration: 'a'.repeat(32), bootId: '' },
  );

  onTestFinished(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('first'));

  const appending = log.append(new TextEncoder().encode('+second'));

  await gate.reached;

  const whileHeld = Bun.peek.status(appending);

  gate.release();

  await appending;

  const text = await readFile(join(ctx.dir, '0.seg'), 'utf8');

  expect(whileHeld).toBe('pending');
  expect(text).toBe('first+second');
});

test('it holds the chosen removal of a segment until the test releases it', async () => {
  const ctx = await setupTest();

  const gate = buildStubGenerationLogGate({ operation: 'removeOldestSegment', call: 1 });

  const log = await gate.createLog(
    {
      dir: ctx.dir,
      segmentBytes: 4,
      maxBytes: 100,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
      log: () => {},
    },
    { session: 'main', executionGeneration: 'a'.repeat(32), bootId: '' },
  );

  onTestFinished(() => {
    log.abandon();
  });

  await log.append(new TextEncoder().encode('aaaabbbb'));

  const removing = log.removeOldestSegment();

  await gate.reached;

  const whileHeld = Bun.peek.status(removing);

  gate.release();

  const isRemoved = await removing;

  expect(whileHeld).toBe('pending');
  expect(isRemoved).toBe(true);
  expect(log.readMeta().segments).toStrictEqual([{ start: 4, length: 4 }]);
});
