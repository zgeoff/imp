import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import type { MoveStatus } from '@imp/api';
import { findImpByName } from '../db/imps';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImagePaths } from '../storage/data-layout';
import { MOVE_PATHS } from './move-header';
import { readWarmHost } from './warm-facts';

// the target's peer URL: a literal tailnet address, as a move needs
const TARGET_URL = 'http://100.100.0.2:7070';

// the source's address, as the target's socket sees it
const SOURCE_PEER = '100.100.0.1';

type FetchHook = (request: Request, forward: () => Promise<Response>) => Promise<Response>;

// Two impds and a sleeping `dev` in slot 1 of the source. `isShared`: both
// report the target's facts, since two impds in one process cannot share a
// data dir, as a warm move needs.
async function setupWarmTest(options: Readonly<{ isShared?: boolean; hook?: FetchHook }> = {}) {
  const source = await setupImpTest();
  const target = await setupImpTest({ env: { IMP_PEER_URL: TARGET_URL } });

  const facts = readWarmHost(target.config, target.readIdentity(), 'xfs');
  const shared = options.isShared === false ? {} : { readWarmHost: () => facts };
  const targetApp = buildTestApp(target, target, undefined, {}, null, shared);
  const sendToTarget = (request: Request) => targetApp.moves.handle(request, SOURCE_PEER);
  const hook = options.hook;

  const sourceApp = buildTestApp(source, source, undefined, {}, null, {
    ...shared,
    fetch: (request) =>
      hook === undefined ? sendToTarget(request) : hook(request, () => sendToTarget(request)),
  });

  for (const host of [source, target]) {
    await host.createTestImage('ubuntu');

    writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');
  }

  // slot 0 goes to another imp, so the target's lowest free slot is not dev's
  await sourceApp.client.imps.create({ name: 'first', image: 'ubuntu' });

  const created = await sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await sourceApp.client.imps.sleep({ name: 'dev' });

  const waitForMove = async (): Promise<MoveStatus> => {
    for (let tries = 0; tries < 500; tries += 1) {
      const status = await sourceApp.client.moves.status({ name: 'dev' });

      if (status.isDone || status.error !== null) {
        return status;
      }

      await Bun.sleep(10);
    }

    throw new Error('the move never ended');
  };

  // a whole move, as `imp move` runs it
  const runMove = async (): Promise<MoveStatus> => {
    const targetFacts = await targetApp.client.moves.facts();
    const plan = await sourceApp.client.moves.prepare({ name: 'dev', target: targetFacts });

    const ticket = await targetApp.client.moves.receive({
      name: 'dev',
      bytes: plan.bytes,
      ...(plan.warm !== null && { warm: plan.warm }),
    });

    await sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

    return waitForMove();
  };

  return {
    source,
    target,
    sourceApp,
    targetApp,
    impId: created.id,
    slot: created.slot,
    runMove,
    async [Symbol.asyncDispose]() {
      await source[Symbol.asyncDispose]();
      await target[Symbol.asyncDispose]();
    },
  };
}

test('a sleeping imp moves with its memory into its slot, and wakes from it there', async () => {
  await using ctx = await setupWarmTest();

  const status = await ctx.runMove();
  const moved = await findImpByName(ctx.target.db, 'dev');

  const meta = readSnapshotMeta(ctx.target.storage.resolveImpPaths(ctx.impId));

  const left = await findImpByName(ctx.source.db, 'dev');
  const woken = await ctx.targetApp.client.imps.wake({ name: 'dev' });

  expect(status).toMatchObject({ isDone: true, error: null });

  expect(moved).toMatchObject({
    id: ctx.impId,
    slot: ctx.slot,
    state: 'sleeping',
    moveState: null,
  });

  expect(ctx.slot).toBe(1);
  expect(meta).not.toBeNull();
  expect(left).toBeUndefined();
  expect(woken.state).toBe('running');
  expect(ctx.target.fake.wakes).toHaveLength(1);
});

test('a sleeping imp is refused a warm move with each fact the target lacks, and stays', async () => {
  await using ctx = await setupWarmTest({ isShared: false });

  const facts = await ctx.targetApp.client.moves.facts();

  const refused = await readRejection(
    ctx.sourceApp.client.moves.prepare({
      name: 'dev',
      target: { ...facts, cpuFlags: 'other-flags', brokerPort: 9999 },
    }),
  );

  const after = await findImpByName(ctx.source.db, 'dev');

  expect(refused).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(String(refused)).toContain('IMP_DATA_DIR differs');
  expect(String(refused)).toContain('the CPU flags differ');
  expect(String(refused)).toContain('IMP_BROKER_PORT differs');
  expect(String(refused)).toContain('imp move --stop moves it cold');
  expect(after).toMatchObject({ state: 'sleeping', moveState: null });
});

test('the target checks the facts itself, and keeps the slot from a new imp', async () => {
  await using ctx = await setupWarmTest();

  const plan = await ctx.sourceApp.client.moves.prepare({
    name: 'dev',
    target: await ctx.targetApp.client.moves.facts(),
  });

  const warm = plan.warm;

  if (warm === null) {
    throw new Error('the plan is cold');
  }

  const forged = await readRejection(
    ctx.targetApp.client.moves.receive({
      name: 'dev',
      bytes: plan.bytes,
      warm: { ...warm, snapshot: { ...warm.snapshot, cpuModel: 'Other CPU' } },
    }),
  );

  await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: plan.bytes, warm });

  const again = await readRejection(
    ctx.targetApp.client.moves.receive({ name: 'other', bytes: plan.bytes, warm }),
  );

  const first = await ctx.targetApp.client.imps.create({ name: 'a', image: 'ubuntu' });
  const second = await ctx.targetApp.client.imps.create({ name: 'b', image: 'ubuntu' });

  expect(forged).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(String(forged)).toContain('the CPU differs');
  expect(again).toMatchObject({ code: 'CONFLICT' });
  expect([first.slot, second.slot]).toEqual([0, 2]);
});

test('a commit with the memory snapshot incomplete is refused, and the source keeps its copy', async () => {
  const state: { metaPath: string | null } = { metaPath: null };

  await using ctx = await setupWarmTest({
    hook: (request, forward) => {
      if (new URL(request.url).pathname === MOVE_PATHS.commit && state.metaPath !== null) {
        rmSync(state.metaPath, { force: true });
      }

      return forward();
    },
  });

  state.metaPath = ctx.target.storage.resolveImpPaths(ctx.impId).snapshotMeta;

  const status = await ctx.runMove();
  const staged = await findImpByName(ctx.target.db, 'dev');
  const kept = await findImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('not complete');
  expect(staged).toMatchObject({ moveState: 'receiving' });
  expect(kept).toMatchObject({ moveState: 'moved', state: 'sleeping' });
  expect(existsSync(ctx.source.storage.resolveImpPaths(ctx.impId).memFile)).toBe(true);
});

test("the first wake after a warm move installs the target's broker CA once", async () => {
  await using ctx = await setupWarmTest();

  await ctx.runMove();

  const readPending = async () => {
    const row = await ctx.target.db
      .selectFrom('imps')
      .select('trust_pending')
      .where('id', '=', ctx.impId)
      .executeTakeFirstOrThrow();

    return row.trust_pending;
  };

  const before = await readPending();

  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  for (let tries = 0; tries < 100 && (await readPending()) === 1; tries += 1) {
    await Bun.sleep(5);
  }

  const after = await readPending();

  expect(before).toBe(1);
  expect(after).toBe(0);
});

test('a system drive the target lacks goes along, and one off its own path is refused', async () => {
  await using ctx = await setupWarmTest();

  // the target lacks the drive; in one process the source's path is not the target's
  rmSync(ctx.target.readIdentity().systemDrivePath, { force: true });

  const status = await ctx.runMove();
  const staged = await findImpByName(ctx.target.db, 'dev');
  const kept = await findImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain("the snapshot's drive is not at");
  expect(staged).toBeUndefined();
  expect(kept).toMatchObject({ state: 'sleeping', moveState: null });
});
