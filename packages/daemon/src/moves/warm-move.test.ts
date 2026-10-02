import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { findImpByName, isSlotFree, updateImpDisk } from '../db/imps';
import { writeMember, writeNetwork } from '../db/networks';
import { readRejection } from '../read-rejection';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { VmIdentitySchema } from '../sleep/vm-identity';
import { MOVE_PART_HEADER, MOVE_PATHS, MoveOfferReplySchema } from './move-header';
import { createUbuntuImage, setupMoveHosts } from './test-moves';
import type { FetchHook } from './test-moves';

interface WarmTestOptions {
  readonly isShared?: boolean;
  readonly hook?: FetchHook;
  readonly partBytes?: number;
  readonly readTapMac?: (tap: string) => string | null;
}

// Two impds and a sleeping `dev` in slot 1 of the source. `isShared`: both
// report the target's facts (setupMoveHosts).
async function setupWarmTest(options: WarmTestOptions = {}) {
  const hosts = await setupMoveHosts({
    isShared: options.isShared !== false,
    ...(options.hook !== undefined && { hook: options.hook }),
    ...(options.partBytes !== undefined && { partBytes: options.partBytes }),
    ...(options.readTapMac !== undefined && { readTapMac: options.readTapMac }),
  });

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  // slot 0 goes to another imp, so the target's lowest free slot is not dev's
  await hosts.sourceApp.client.imps.create({ name: 'first', image: 'ubuntu' });

  const created = await hosts.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await hosts.sourceApp.client.imps.sleep({ name: 'dev' });

  // whether the target would let a new warm move keep dev's slot
  const isTargetSlotFree = () => isSlotFree(hosts.target.db, created.slot, hosts.target.now());

  return {
    ...hosts,
    impId: created.id,
    slot: created.slot,
    runMove: () => hosts.runMove('dev'),
    isTargetSlotFree,
  };
}

// the commit's request fails `count` times, as a network that drops it
function buildCommitDrop(count: number): FetchHook {
  const lost = { commits: count };

  return (request, forward) => {
    if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
      lost.commits -= 1;

      return Promise.reject(new Error('the network dropped the commit'));
    }

    return forward();
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

test('a system drive the target lacks goes along, and one whose sum is not its name is refused', async () => {
  await using ctx = await setupWarmTest({
    // in one process both hosts open one drive file: the target says it lacks it
    hook: async (request, forward) => {
      const response = await forward();

      if (!request.url.endsWith(MOVE_PATHS.offer)) {
        return response;
      }

      const body: unknown = await response.json();

      const offer = MoveOfferReplySchema.parse(body);

      return Response.json({ ...offer, needsSystemDrive: true });
    },
  });

  // the test drive's bytes are not the data its name hashes
  const status = await ctx.runMove();
  const staged = await findImpByName(ctx.target.db, 'dev');
  const kept = await findImpByName(ctx.source.db, 'dev');
  const isFree = await ctx.isTargetSlotFree();

  expect(status.error).toContain('the system drive does not match its sha256');
  expect(staged).toBeUndefined();
  expect(isFree).toBe(true);
  expect(kept).toMatchObject({ state: 'sleeping', moveState: null });
});

test("a snapshot that opens a drive off the target's own path is refused", async () => {
  await using ctx = await setupWarmTest();

  const vmIdentity = ctx.source.storage.resolveImpPaths(ctx.impId).vmIdentity;
  const vm = VmIdentitySchema.parse(JSON.parse(readFileSync(vmIdentity, 'utf8')));

  writeFileSync(vmIdentity, JSON.stringify({ ...vm, systemDrivePath: '/etc/shadow' }));

  const status = await ctx.runMove();
  const staged = await findImpByName(ctx.target.db, 'dev');
  const isFree = await ctx.isTargetSlotFree();

  expect(status.error).toContain("the snapshot's drive is not at");
  expect(staged).toBeUndefined();
  expect(isFree).toBe(true);
});

test('a warm move whose commit was lost commits warm on resume, with a reissued ticket', async () => {
  await using ctx = await setupWarmTest({ hook: buildCommitDrop(1) });

  const lost = await ctx.runMove();
  const ticket = await ctx.targetApp.client.moves.reissue({ name: 'dev' });

  const resumed = await ctx.sourceApp.client.moves.resume({
    name: 'dev',
    ticket: ticket.ticket,
  });

  const moved = await findImpByName(ctx.target.db, 'dev');
  const woken = await ctx.targetApp.client.imps.wake({ name: 'dev' });

  expect(lost.error).toContain('dropped the commit');
  expect(resumed.isDone).toBe(true);
  expect(moved).toMatchObject({ slot: ctx.slot, state: 'sleeping', moveState: null });
  expect(woken.state).toBe('running');
  expect(ctx.target.fake.wakes).toHaveLength(1);
});

test('a source restart with the warm move verified commits it warm', async () => {
  await using ctx = await setupWarmTest({ hook: buildCommitDrop(1) });

  await ctx.runMove();
  await ctx.sourceApp.moves.recover();

  for (let tries = 0; tries < 500; tries += 1) {
    if ((await findImpByName(ctx.source.db, 'dev')) === undefined) {
      break;
    }

    await Bun.sleep(10);
  }

  const gone = await findImpByName(ctx.source.db, 'dev');
  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(gone).toBeUndefined();
  expect(moved).toMatchObject({ state: 'sleeping', moveState: null });
});

test('an abort after the receipt leaves the imp asleep on the source, and frees the slot', async () => {
  await using ctx = await setupWarmTest({ hook: buildCommitDrop(1) });

  await ctx.runMove();
  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const staged = await findImpByName(ctx.target.db, 'dev');
  const isFree = await ctx.isTargetSlotFree();

  const memoryDir = ctx.target.storage.resolveImpPaths(ctx.impId).snapshotDir;

  const woken = await ctx.sourceApp.client.imps.wake({ name: 'dev' });

  expect(staged).toBeUndefined();
  expect(isFree).toBe(true);
  expect(existsSync(memoryDir)).toBe(false);
  expect(woken.state).toBe('running');
});

test('a warm stream cut short, with no abort, removes the memory and frees the slot', async () => {
  const clock: { advance: (ms: number) => void } = { advance: () => {} };

  await using ctx = await setupWarmTest({
    partBytes: 4096,
    hook: (request, forward) => {
      // the source goes quiet past the gap, and its abort never arrives
      if (request.url.endsWith(MOVE_PATHS.abort)) {
        return Promise.reject(new Error('the source is gone'));
      }

      if (request.headers.get(MOVE_PART_HEADER) === '1') {
        clock.advance(61_000);
      }

      return forward();
    },
  });

  clock.advance = ctx.target.advance;

  writeFileSync(ctx.source.storage.resolveImpPaths(ctx.impId).disk, 'x'.repeat(64 * 1024));

  const status = await ctx.runMove();
  const staged = await findImpByName(ctx.target.db, 'dev');
  const isFree = await ctx.isTargetSlotFree();

  const memoryDir = ctx.target.storage.resolveImpPaths(ctx.impId).snapshotDir;

  // the target ended the stream on its own; the source still owes the abort
  expect(status.error).toContain('did not confirm the abort');
  expect(staged).toBeUndefined();
  expect(isFree).toBe(true);
  expect(existsSync(memoryDir)).toBe(false);
});

test('a pending disk grow goes along, and the first wake on the target grows the guest', async () => {
  await using ctx = await setupWarmTest();

  const imp = await findImpByName(ctx.source.db, 'dev');

  await updateImpDisk(ctx.source.db, ctx.impId, {
    diskBytes: imp?.diskBytes ?? 0,
    isGrowPending: true,
  });

  await ctx.runMove();

  const moved = await findImpByName(ctx.target.db, 'dev');

  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  const grown = await findImpByName(ctx.target.db, 'dev');

  expect(moved?.isDiskGrowPending).toBe(true);
  expect(grown?.isDiskGrowPending).toBe(false);
});

test("a tap with a MAC from before slot MACs, or none, refuses a warm move, and the target's slot tap goes", async () => {
  await using refused = await setupWarmTest({ readTapMac: () => '02:aa:bb:cc:dd:ee' });

  const facts = await refused.targetApp.client.moves.facts();

  const rejection = await readRejection(
    refused.sourceApp.client.moves.prepare({ name: 'dev', target: facts }),
  );

  // a host restart took the tap: the guest may still hold the old MAC
  await using gone = await setupWarmTest({ readTapMac: () => null });

  const goneFacts = await gone.targetApp.client.moves.facts();

  const noTap = await readRejection(
    gone.sourceApp.client.moves.prepare({ name: 'dev', target: goneFacts }),
  );

  await using ctx = await setupWarmTest();

  await ctx.runMove();

  expect(rejection).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(String(rejection)).toContain('has a MAC from before slot MACs');
  expect(String(noTap)).toContain('wake it once first');
  expect(ctx.target.removedTaps).toContain(`imp${String(ctx.slot)}`);
});

test('an imp on a private network is refused a warm move', async () => {
  await using ctx = await setupWarmTest();

  const network = await writeNetwork(ctx.source.db, 'lab');

  await writeMember(ctx.source.db, network?.id ?? '', ctx.impId);

  const facts = await ctx.targetApp.client.moves.facts();

  const refused = await readRejection(
    ctx.sourceApp.client.moves.prepare({ name: 'dev', target: facts }),
  );

  expect(refused).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(String(refused)).toContain('it is on private networks (lab)');
});
