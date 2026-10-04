import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { NoSessionDataSchema } from '@imp/api';
import * as z from 'zod';
import { AgentError } from '../agent-client/agent-connection';
import { startFakeAgent } from '../agent-client/fake-agent';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { listColdBoots, writeColdBoot } from '../db/cold-boots';
import { findImpByName } from '../db/imps';
import { readRejection } from '../read-rejection';
import { buildImpPaths } from '../storage/data-layout';
import { buildFakeBootId } from './fake-vmm';
import { buildTestApp, setupImpTest } from './test-imps';

// Each cold boot records its cause, and an attach to a session names them
// (docs/architecture/daemon.md#output-offsets).

const GENERATION = 'c'.repeat(32);
const AgentRequestSchema = z.object({ op: z.string() }).loose();

async function setupColdBootTest() {
  const harness = await setupImpTest();

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  const created = await app.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(harness.dataDir, created.id);

  const readCauses = async () => {
    const boots = await listColdBoots(harness.db, created.id);

    return boots.map((boot) => boot.cause);
  };

  // what impd's liveness check finds after the guest crashed or rebooted
  const stopVmUnseen = async () => {
    const imp = await findImpByName(harness.db, 'dev');

    harness.fake.alive.delete(imp?.pid ?? 0);
  };

  return { ...harness, ...app, created, paths, readCauses, stopVmUnseen };
}

// an agent whose session.attach answers `reply`, and whose ping reports `bootId`
function startSessionAgent(path: string, reply: (socket: Socket) => void, bootId = 'boot-old') {
  return startFakeAgent(path, (socket, request, frames) => {
    if (frames.length !== 1) {
      return;
    }

    const parsed = AgentRequestSchema.parse(decodeJsonPayload(request));

    if (parsed.op === 'ping') {
      socket.end(
        encodeJsonFrame(FRAME_TYPES.response, { ok: true, version: '0.15.0', boot_id: bootId }),
      );

      return;
    }

    reply(socket);
  });
}

function sendNoSession(socket: Socket): void {
  socket.end(
    encodeJsonFrame(FRAME_TYPES.response, {
      error: {
        code: 'NO_SESSION',
        message: 'no session "main"',
        data: {
          boot_id: '22222222-2222-4222-8222-222222222222',
          previous: { execution_generation: GENERATION, end: 12, exit: { code: 137, signal: 9 } },
        },
      },
    }),
  );
}

test('a create, a stop and start, and a wake that falls back each record their cause', async () => {
  await using ctx = await setupColdBootTest();

  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.imps.start({ name: 'dev' });

  // a memory wake keeps the boot
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const memoryWake = await ctx.readCauses();

  expect(memoryWake).toEqual(['start', 'start']);

  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');

  await ctx.client.imps.wake({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, ctx.created.id);
  const imp = await findImpByName(ctx.db, 'dev');

  expect(boots.map((boot) => boot.cause)).toEqual(['wake_fallback', 'start', 'start']);
  expect(boots[0]?.bootId).toBe(buildFakeBootId(imp?.pid ?? 0));
  expect(new Set(boots.map((boot) => boot.bootId)).size).toBe(3);
});

test('impd keeps the last 4 cold boots, newest first', async () => {
  await using ctx = await setupColdBootTest();

  for (let restart = 0; restart < 5; restart += 1) {
    ctx.fake.queue('wake', 'fail');

    await ctx.client.imps.sleep({ name: 'dev' });
    await ctx.client.imps.wake({ name: 'dev' });
  }

  const boots = await listColdBoots(ctx.db, ctx.created.id);

  expect(boots).toHaveLength(4);

  const times = boots.map((boot) => boot.at);

  expect(boots.map((boot) => boot.cause)).toEqual([
    'wake_fallback',
    'wake_fallback',
    'wake_fallback',
    'wake_fallback',
  ]);

  expect(times).toEqual(times.toSorted().toReversed());
});

test('a restore of a running imp boots it with the cause restore; of a stopped one, its next boot', async () => {
  await using ctx = await setupColdBootTest();

  const checkpoint = await ctx.client.checkpoints.create({ name: 'dev' });

  await ctx.client.checkpoints.restore({ name: 'dev', checkpoint: checkpoint.id });

  const running = await ctx.readCauses();

  expect(running).toEqual(['restore', 'start']);

  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.checkpoints.restore({ name: 'dev', checkpoint: checkpoint.id });
  await ctx.client.imps.start({ name: 'dev' });

  const stopped = await ctx.readCauses();

  expect(stopped).toEqual(['restore', 'restore', 'start']);
});

test('the boot after impd found the VM gone is a recovery, whatever path boots it', async () => {
  await using ctx = await setupColdBootTest();

  await ctx.stopVmUnseen();

  const found = await ctx.client.imps.get({ name: 'dev' });

  await ctx.client.imps.start({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.imps.start({ name: 'dev' });

  const causes = await ctx.readCauses();

  expect(found.state).toBe('stopped');
  expect(causes).toEqual(['start', 'recovery', 'start']);
});

// the attach boots the stopped imp: its boot comes first, and the recovery
// that ended the client's generation stays in the list
test('an attach that boots a crashed imp answers NO_SESSION with its cold boots', async () => {
  await using ctx = await setupColdBootTest();

  const agent = await startSessionAgent(ctx.paths.vsockSocket, sendNoSession);

  await ctx.stopVmUnseen();
  await ctx.client.imps.get({ name: 'dev' });

  const error = await readRejection(ctx.imps.openAttach('dev', { session: 'main' }));

  agent.close();

  if (!(error instanceof AgentError)) {
    throw new Error('no AgentError');
  }

  const data = NoSessionDataSchema.parse(error.data);

  expect(error.code).toBe('NO_SESSION');
  expect(data.bootId).toBe('22222222-2222-4222-8222-222222222222');
  expect(data.coldBoots.map((boot) => boot.cause)).toEqual(['recovery', 'start']);
  expect(data.previous).toEqual({ executionGeneration: GENERATION, end: 12, exitCode: null });
});

test('an attach with wake false fails with INVALID_STATE and boots nothing', async () => {
  await using ctx = await setupColdBootTest();

  await ctx.client.imps.stop({ name: 'dev' });

  const boots = ctx.fake.boots.length;

  const stopped = await readRejection(ctx.imps.openAttach('dev', { session: 'main', wake: false }));

  await ctx.client.imps.start({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const wakes = ctx.fake.wakes.length;

  const sleeping = await readRejection(
    ctx.imps.openAttach('dev', { session: 'main', wake: false }),
  );

  expect(stopped).toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'stopped', allowed: ['running'], coldBoots: [{ cause: 'start' }] },
  });

  expect(sleeping).toMatchObject({ code: 'INVALID_STATE', data: { state: 'sleeping' } });
  expect(ctx.fake.boots.length).toBe(boots + 1);
  expect(ctx.fake.wakes.length).toBe(wakes);
});

test('a session’s started output names the cold boots; a resume error keeps its data', async () => {
  await using ctx = await setupColdBootTest();

  const replies = [
    (socket: Socket) => {
      socket.write(
        encodeJsonFrame(FRAME_TYPES.started, {
          pid: 9,
          session: 'main',
          output: {
            boot_id: '22222222-2222-4222-8222-222222222222',
            execution_generation: GENERATION,
            buffer_start: 0,
            end: 5,
            offset: 2,
            prelude: 0,
            resume: { kind: 'exact' },
          },
        }),
      );
    },
    (socket: Socket) => {
      socket.end(
        encodeJsonFrame(FRAME_TYPES.response, {
          error: {
            code: 'INVALID_RESUME',
            message: 'offset 9 is past the end of the output, 5',
            data: { end: 5, buffer_start: 0 },
          },
        }),
      );
    },
  ];

  const agent = await startSessionAgent(ctx.paths.vsockSocket, (socket) => {
    replies.shift()?.(socket);
  });

  const resumeFrom = { executionGeneration: GENERATION, offset: 2 };

  const stream = await ctx.imps.openAttach('dev', { session: 'main', resumeFrom });

  stream.close();

  const invalid = await readRejection(
    ctx.imps.openAttach('dev', { session: 'main', resumeFrom: { ...resumeFrom, offset: 9 } }),
  );

  agent.close();

  expect(stream.output).toEqual({
    continuity: 'offsets',
    bootId: '22222222-2222-4222-8222-222222222222',
    executionGeneration: GENERATION,
    bufferStart: 0,
    end: 5,
    offset: 2,
    prelude: 0,
    coldBoots: [expect.objectContaining({ cause: 'start' })],
    resume: { kind: 'exact' },
  });

  expect(invalid).toMatchObject({ code: 'INVALID_RESUME', data: { end: 5, bufferStart: 0 } });
});

test('a VM impd adopts with a boot it has no record of counts as unknown', async () => {
  await using ctx = await setupColdBootTest();

  const agent = await startSessionAgent(ctx.paths.vsockSocket, () => {}, 'boot-before');

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  agent.close();

  const boots = await listColdBoots(ctx.db, ctx.created.id);

  expect(boots.map((boot) => boot.cause)).toEqual(['unknown', 'start']);
  expect(boots[0]?.bootId).toBe('boot-before');
});

// an imp that went to sleep before impd kept cold boots wakes from memory
// into a boot it has no row for
test('a memory wake into a boot impd has no record of counts as unknown', async () => {
  await using ctx = await setupColdBootTest();

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const kept = await listColdBoots(ctx.db, ctx.created.id);

  await ctx.db.deleteFrom('imp_cold_boots').execute();
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const boots = await listColdBoots(ctx.db, ctx.created.id);

  expect(kept.map((boot) => boot.cause)).toEqual(['start']);
  expect(boots.map((boot) => boot.cause)).toEqual(['unknown']);
  expect(boots[0]?.bootId).toBe(kept[0]?.bootId ?? '');
});

// a lost snapshot fails the wake that would use it, whoever finds it first
test('a sleeping imp whose snapshot is gone boots next with the cause wake_fallback', async () => {
  await using ctx = await setupColdBootTest();

  await ctx.client.imps.sleep({ name: 'dev' });

  rmSync(ctx.paths.snapshotDir, { recursive: true, force: true });

  const found = await ctx.client.imps.get({ name: 'dev' });

  await ctx.client.imps.start({ name: 'dev' });

  const causes = await ctx.readCauses();

  expect(found.state).toBe('stopped');
  expect(causes).toEqual(['wake_fallback', 'start']);
});

test('a boot without a boot_id spends the pending cause, so a later boot does not inherit it', async () => {
  await using ctx = await setupColdBootTest();

  await ctx.stopVmUnseen();
  await ctx.client.imps.get({ name: 'dev' });

  ctx.fake.setGuestBootId(false);

  await ctx.client.imps.start({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  ctx.fake.setGuestBootId(true);

  await ctx.client.imps.start({ name: 'dev' });

  const causes = await ctx.readCauses();

  expect(causes).toEqual(['start', 'start']);
});

test('two boots in the same millisecond list in the order impd recorded them', async () => {
  await using ctx = await setupColdBootTest();

  const at = new Date();

  await writeColdBoot(ctx.db, ctx.created.id, { bootId: 'boot-b', cause: 'start', at });
  await writeColdBoot(ctx.db, ctx.created.id, { bootId: 'boot-a', cause: 'watchdog', at });

  const boots = await listColdBoots(ctx.db, ctx.created.id);

  expect(boots.slice(0, 2).map((boot) => boot.bootId)).toEqual(['boot-a', 'boot-b']);
});
