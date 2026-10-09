import { expect, onTestFinished, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { invariant } from '@imp/test-utils/invariant';
import { FRAME_TYPES, encodeJsonFrame } from '../agent-client/frame-codec';
import { listColdBoots } from '../db/cold-boots';
import { findImpByName } from '../db/imps';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubBootId } from '../test-utils/build-stub-vmm';
import { startStubAttachAgent } from '../test-utils/start-stub-attach-agent';
import { buildTestApp, createImpTest } from './test-imps';

// Each cold boot records its cause, and an attach to a session names them
// (docs/architecture/daemon.md#output-offsets).

// impd over the stub VMM, a client of its API, and `stack`, whose releases
// (the agents a test starts) run before the harness's
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  // every create boots an image row; the default image is ubuntu
  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  return { ...harness, client: app.client, stack };
}

test('it records a create and a start after a stop as start', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.imps.start({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['start', 'start']);
});

test('it records no cold boot for a wake from memory', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['start']);
});

test('it records a wake that falls back to a cold boot as wake_fallback, with a new boot', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');

  await ctx.client.imps.wake({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, created.id);
  const imp = await findImpByName(ctx.db, 'dev');

  invariant(imp?.pid);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['wake_fallback', 'start']);
  expect(boots[0]?.bootId).toBe(buildStubBootId(imp.pid));
  expect(new Set(boots.map((boot) => boot.bootId)).size).toBe(2);
});

test('it keeps the last 4 cold boots, newest first', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  for (let restart = 0; restart < 5; restart += 1) {
    ctx.fake.queue('wake', 'fail');

    await ctx.client.imps.sleep({ name: 'dev' });
    await ctx.client.imps.wake({ name: 'dev' });
  }

  const boots = await listColdBoots(ctx.db, created.id);

  const times = boots.map((boot) => boot.at);

  expect(boots.map((boot) => boot.cause)).toStrictEqual([
    'wake_fallback',
    'wake_fallback',
    'wake_fallback',
    'wake_fallback',
  ]);

  expect(times).toStrictEqual(times.toSorted().toReversed());
});

test('it records the boot of a restore of a running imp as restore', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });
  const checkpoint = await ctx.client.checkpoints.create({ name: 'dev' });

  await ctx.client.checkpoints.restore({ name: 'dev', checkpoint: checkpoint.id });

  const boots = await listColdBoots(ctx.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['restore', 'start']);
});

test('it records the next boot of a stopped imp a restore reset as restore', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });
  const checkpoint = await ctx.client.checkpoints.create({ name: 'dev' });

  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.checkpoints.restore({ name: 'dev', checkpoint: checkpoint.id });
  await ctx.client.imps.start({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['restore', 'start']);
});

test('it records the boot after impd found the VM gone as recovery, and only that boot', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });
  const running = await findImpByName(ctx.db, 'dev');

  invariant(running?.pid);

  // the guest crashed without impd seeing it
  ctx.fake.alive.delete(running.pid);

  const found = await ctx.client.imps.get({ name: 'dev' });

  await ctx.client.imps.start({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.imps.start({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, created.id);

  expect(found.state).toBe('stopped');
  expect(boots.map((boot) => boot.cause)).toStrictEqual(['start', 'recovery', 'start']);
});

// the attach boots the stopped imp: its boot comes first, and the recovery
// that ended the client's generation stays in the list
test('it answers an attach that boots a crashed imp with NO_SESSION and its cold boots', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });
  const running = await findImpByName(ctx.db, 'dev');

  invariant(running?.pid);

  await startStubAttachAgent(buildImpPaths(ctx.dataDir, created.id).vsockSocket, {
    bootId: 'boot-old',
    replies: [
      {
        frame: encodeJsonFrame(FRAME_TYPES.response, {
          error: {
            code: 'NO_SESSION',
            message: 'no session "main"',
            data: {
              boot_id: '22222222-2222-4222-8222-222222222222',
              previous: {
                execution_generation: 'c'.repeat(32),
                end: 12,
                exit: { code: 137, signal: 9 },
              },
            },
          },
        }),
        isEnd: true,
      },
    ],
    stack: ctx.stack,
  });

  // the guest crashed without impd seeing it, and a read found it gone
  ctx.fake.alive.delete(running.pid);

  await ctx.client.imps.get({ name: 'dev' });

  expect(ctx.imps.openAttach('dev', { session: 'main' })).rejects.toMatchObject({
    code: 'NO_SESSION',
    data: {
      bootId: '22222222-2222-4222-8222-222222222222',
      coldBoots: [{ cause: 'recovery' }, { cause: 'start' }],
      previous: { executionGeneration: 'c'.repeat(32), end: 12, exitCode: null },
    },
  });
});

test('it refuses an attach without wake to a stopped imp, with its cold boots', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  expect(ctx.imps.openAttach('dev', { session: 'main', wake: false })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'stopped', allowed: ['running'], coldBoots: [{ cause: 'start' }] },
  });
});

test('it boots nothing for an attach without wake to a stopped imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  expect(ctx.imps.openAttach('dev', { session: 'main', wake: false })).rejects.toThrow();

  // the create's boot alone
  expect(ctx.fake.boots).toHaveLength(1);
});

test('it refuses an attach without wake to a sleeping imp, and wakes nothing', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  expect(ctx.imps.openAttach('dev', { session: 'main', wake: false })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'sleeping' },
  });

  expect(ctx.fake.wakes).toBeEmpty();
});

test('it names the cold boots in a session’s started output', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await startStubAttachAgent(buildImpPaths(ctx.dataDir, created.id).vsockSocket, {
    bootId: 'boot-old',
    replies: [
      {
        frame: encodeJsonFrame(FRAME_TYPES.started, {
          pid: 9,
          session: 'main',
          output: {
            boot_id: '22222222-2222-4222-8222-222222222222',
            execution_generation: 'c'.repeat(32),
            buffer_start: 0,
            end: 5,
            offset: 2,
            prelude: 0,
            resume: { kind: 'exact' },
          },
        }),
        isEnd: false,
      },
    ],
    stack: ctx.stack,
  });

  const stream = await ctx.imps.openAttach('dev', {
    session: 'main',
    resumeFrom: { executionGeneration: 'c'.repeat(32), offset: 2 },
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  const imp = await findImpByName(ctx.db, 'dev');

  invariant(imp?.pid);

  // the cold boot's id is the stub guest's for the VM's pid, and its time the clock's
  expect(stream.output).toStrictEqual({
    continuity: 'offsets',
    bootId: '22222222-2222-4222-8222-222222222222',
    executionGeneration: 'c'.repeat(32),
    bufferStart: 0,
    end: 5,
    offset: 2,
    prelude: 0,
    coldBoots: [
      {
        bootId: buildStubBootId(imp.pid),
        cause: 'start',
        at: expect.toSatisfy((at: string) => !Number.isNaN(Date.parse(at))),
      },
    ],
    resume: { kind: 'exact' },
  });
});

test('it keeps the data of a resume error the agent sends', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await startStubAttachAgent(buildImpPaths(ctx.dataDir, created.id).vsockSocket, {
    bootId: 'boot-old',
    replies: [
      {
        frame: encodeJsonFrame(FRAME_TYPES.response, {
          error: {
            code: 'INVALID_RESUME',
            message: 'offset 9 is past the end of the output, 5',
            data: { end: 5, buffer_start: 0 },
          },
        }),
        isEnd: true,
      },
    ],
    stack: ctx.stack,
  });

  expect(
    ctx.imps.openAttach('dev', {
      session: 'main',
      resumeFrom: { executionGeneration: 'c'.repeat(32), offset: 9 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_RESUME', data: { end: 5, bufferStart: 0 } });
});

test('it records a VM impd adopts with a boot it has no record of as unknown', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await startStubAttachAgent(buildImpPaths(ctx.dataDir, created.id).vsockSocket, {
    bootId: 'boot-before',
    stack: ctx.stack,
  });

  await ctx.restartImpd().imps.reconcileImps();

  const boots = await listColdBoots(ctx.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['unknown', 'start']);
  expect(boots[0]?.bootId).toBe('boot-before');
});

// an imp that went to sleep before impd kept cold boots wakes from memory
// into a boot it has no row for
test('it records a memory wake into a boot impd has no record of as unknown', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });
  const [booted] = await listColdBoots(ctx.db, created.id);

  invariant(booted);

  await ctx.db.deleteFrom('imp_cold_boots').execute();
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['unknown']);
  expect(boots[0]?.bootId).toBe(booted.bootId);
});

// a lost snapshot fails the wake that would use it, whoever finds it first
test('it records the next boot of a sleeping imp whose snapshot is gone as wake_fallback', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  rmSync(buildImpPaths(ctx.dataDir, created.id).snapshotDir, { recursive: true, force: true });

  const found = await ctx.client.imps.get({ name: 'dev' });

  await ctx.client.imps.start({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, created.id);

  expect(found.state).toBe('stopped');
  expect(boots.map((boot) => boot.cause)).toStrictEqual(['wake_fallback', 'start']);
});

test('it spends the pending cause on a boot without a boot_id, so a later boot does not inherit it', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });
  const running = await findImpByName(ctx.db, 'dev');

  invariant(running?.pid);

  // the guest crashed without impd seeing it, and a read found it gone
  ctx.fake.alive.delete(running.pid);

  await ctx.client.imps.get({ name: 'dev' });

  ctx.fake.setGuestBootId(false);

  await ctx.client.imps.start({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  ctx.fake.setGuestBootId(true);

  await ctx.client.imps.start({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['start', 'start']);
});
