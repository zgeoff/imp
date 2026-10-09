import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { listColdBoots, writeUnknownBoot } from '../db/cold-boots';
import { JAIL_UIDS, findImpByName, isSlotFree, updateImpDisk } from '../db/imps';
import { writeMember, writeNetwork } from '../db/networks';
import { readSnapshotMeta, writeSnapshotMeta } from '../sleep/snapshot-meta';
import { VmIdentitySchema } from '../sleep/vm-identity';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import {
  buildJsonMoveFrame,
  buildStubMoveStreamRewrite,
} from '../test-utils/build-stub-move-stream-rewrite';
import { MOVE_FRAMES, readJsonPayload } from './move-frames';
import {
  MOVE_PART_HEADER,
  MOVE_PATHS,
  MoveHeaderSchema,
  MoveOfferReplySchema,
} from './move-header';
import { createUbuntuImage, setupMoveHosts } from './test-moves';
import type { MoveHostsOptions } from './test-moves';

// Two impds, each with the image a create reads
async function setupTest(
  config: Pick<
    MoveHostsOptions,
    'hook' | 'isShared' | 'partBytes' | 'readTapMac' | 'source' | 'target'
  > = {},
) {
  const hosts = await setupMoveHosts(config);

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  return hosts;
}

test('it moves a sleeping imp with its memory into its own slot', async () => {
  const ctx = await setupTest({ isShared: true });

  // slot 0 goes to another imp, so the target's lowest free slot is not dev's
  await ctx.sourceApp.client.imps.create({ name: 'first', image: 'ubuntu' });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const moved = await findImpByName(ctx.target.db, 'dev');
  const left = await findImpByName(ctx.source.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved).toMatchObject({ id: created.id, slot: 1, state: 'sleeping', moveState: null });
  expect(readSnapshotMeta(ctx.target.storage.resolveImpPaths(created.id))).toBeObject();
  expect(left).toBeUndefined();
});

test('it wakes a warm-moved imp from its memory on the target', async () => {
  const ctx = await setupTest({ isShared: true });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });
  await ctx.runMove('dev');

  const woken = await ctx.targetApp.client.imps.wake({ name: 'dev' });

  expect(woken.state).toBe('running');
  expect(ctx.target.fake.wakes).toHaveLength(1);
});

test('it moves an elastic imp warm with its max memory', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', created.id)
    .execute();

  const status = await ctx.runMove('dev');
  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved).toMatchObject({ memoryMib: 256, maxMemoryMib: 1024 });
});

test('it lets the first wake on the target hold the memory an elastic imp had plugged', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', created.id)
    .execute();

  const sourcePaths = ctx.source.storage.resolveImpPaths(created.id);
  const slept = readSnapshotMeta(sourcePaths);

  invariant(slept);
  writeSnapshotMeta(sourcePaths, { ...slept, memoryMib: 256, pluggedMib: 512 });

  await ctx.runMove('dev');
  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  const lastLimit = ctx.target.memoryLimits.findLast((limit) => limit.impId === created.id);

  expect(lastLimit).toStrictEqual({ impId: created.id, guestMib: 768 });
});

// The target's Firecracker runs as the uid the target gives the imp, never
// the source's (docs/architecture/daemon.md#the-jailer)
test("it gives a jailed imp moved warm the target's own jail uid", async () => {
  const ctx = await setupTest({
    isShared: true,

    // both hosts run every VM under the jailer, which needs a cgroup per VM
    source: {
      cgroups: buildStubCpuCgroups({ isMemoryEnforced: true }).cgroups,
      env: { IMP_JAILER: 'true' },
    },
    target: {
      cgroups: buildStubCpuCgroups({ isMemoryEnforced: true }).cgroups,
      env: { IMP_JAILER: 'true' },
    },
  });

  await ctx.sourceApp.client.imps.create({ name: 'first', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  // the source's first imp holds the first uid, so dev's there is the next
  const before = await findImpByName(ctx.source.db, 'dev');

  await ctx.runMove('dev');

  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(before?.jailUid).toBe(JAIL_UIDS.first + 1);
  expect(moved?.jailUid).toBe(JAIL_UIDS.first);
});

// The wake's jail prepare chowns the disk and the snapshot to the imp's uid,
// so they must be in place by then
test('it wakes a jailed imp moved warm as its jail uid, with its files in place', async () => {
  const ctx = await setupTest({
    isShared: true,

    // both hosts run every VM under the jailer, which needs a cgroup per VM
    source: {
      cgroups: buildStubCpuCgroups({ isMemoryEnforced: true }).cgroups,
      env: { IMP_JAILER: 'true' },
    },
    target: {
      cgroups: buildStubCpuCgroups({ isMemoryEnforced: true }).cgroups,
      env: { IMP_JAILER: 'true' },
    },
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });
  await ctx.runMove('dev');
  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  const paths = ctx.target.storage.resolveImpPaths(created.id);

  expect(ctx.target.fake.wakeJails).toStrictEqual([
    {
      jail: { uid: JAIL_UIDS.first, gid: JAIL_UIDS.first },
      files: [paths.disk, paths.vmstate, paths.memFile],
    },
  ]);
});

test('it refuses a warm move naming each fact the target lacks, and leaves the imp asleep', async () => {
  const ctx = await setupTest({ isShared: false });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const facts = await ctx.targetApp.client.moves.facts();

  const prepared = ctx.sourceApp.client.moves.prepare({
    name: 'dev',
    target: { ...facts, cpuFlags: 'other-flags', brokerPort: 9999 },
  });

  expect(prepared).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.toIncludeMultiple([
      'IMP_DATA_DIR differs',
      'the CPU flags differ',
      'IMP_BROKER_PORT differs',
      'imp move --stop moves it cold',
    ]),
  });

  const after = await findImpByName(ctx.source.db, 'dev');

  expect(after).toMatchObject({ state: 'sleeping', moveState: null });
});

test('it refuses a warm receive whose snapshot facts the target does not share', async () => {
  const ctx = await setupTest({ isShared: true });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const plan = await ctx.sourceApp.client.moves.prepare({
    name: 'dev',
    target: await ctx.targetApp.client.moves.facts(),
  });

  invariant(plan.warm);

  expect(
    ctx.targetApp.client.moves.receive({
      name: 'dev',
      bytes: plan.bytes,
      warm: { ...plan.warm, snapshot: { ...plan.warm.snapshot, cpuModel: 'Other CPU' } },
    }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.toInclude('the CPU differs'),
  });
});

test('it refuses a second warm receive for the slot a ticket holds', async () => {
  const ctx = await setupTest({ isShared: true });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const plan = await ctx.sourceApp.client.moves.prepare({
    name: 'dev',
    target: await ctx.targetApp.client.moves.facts(),
  });

  invariant(plan.warm);

  await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: plan.bytes, warm: plan.warm });

  expect(
    ctx.targetApp.client.moves.receive({ name: 'other', bytes: plan.bytes, warm: plan.warm }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('it keeps the slot a warm ticket holds from a new imp on the target', async () => {
  const ctx = await setupTest({ isShared: true });

  await ctx.sourceApp.client.imps.create({ name: 'first', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const plan = await ctx.sourceApp.client.moves.prepare({
    name: 'dev',
    target: await ctx.targetApp.client.moves.facts(),
  });

  invariant(plan.warm);

  await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: plan.bytes, warm: plan.warm });

  const first = await ctx.targetApp.client.imps.create({ name: 'a', image: 'ubuntu' });
  const second = await ctx.targetApp.client.imps.create({ name: 'b', image: 'ubuntu' });

  expect(first.slot).toBe(0);
  expect(second.slot).toBe(2);
});

test('it refuses a commit with the memory snapshot incomplete, and the source keeps its copy', async () => {
  const state: { metaPath: string | null } = { metaPath: null };

  const ctx = await setupTest({
    isShared: true,

    // the target's snapshot record goes missing just before the commit
    hook: (request, forward) => {
      if (new URL(request.url).pathname === MOVE_PATHS.commit && state.metaPath !== null) {
        rmSync(state.metaPath, { force: true });
      }

      return forward();
    },
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  state.metaPath = ctx.target.storage.resolveImpPaths(created.id).snapshotMeta;

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');
  const kept = await findImpByName(ctx.source.db, 'dev');

  expect(status.error).toInclude('the received memory snapshot is not complete');
  expect(staged).toMatchObject({ moveState: 'receiving' });
  expect(kept).toMatchObject({ moveState: 'moved', state: 'sleeping' });
  expect(existsSync(ctx.source.storage.resolveImpPaths(created.id).memFile)).toBe(true);
});

test('it refuses a warm stream whose header names another slot than its ticket keeps', async () => {
  const ctx = await setupTest({
    isShared: true,

    // a faulty source: the header's slot is one past the slot it was offered
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        invariant(header.warm);

        return buildJsonMoveFrame(MOVE_FRAMES.header, {
          ...header,
          warm: { ...header.warm, move: { ...header.warm.move, slot: header.warm.move.slot + 1 } },
        });
      }),
    ),
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toInclude(`the ticket keeps slot ${String(created.slot)}, not this one`);
  expect(staged).toBeUndefined();
});

test('it refuses a cold stream on the ticket of a warm move', async () => {
  const ctx = await setupTest({
    isShared: true,

    // a faulty source: the header drops the memory it was offered with
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(MOVE_FRAMES.header, { ...header, warm: null });
      }),
    ),
  });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toInclude('the ticket is for a warm move, and the stream is cold');
  expect(staged).toBeUndefined();
});

test('it refuses a warm stream whose header names facts the target does not share', async () => {
  const ctx = await setupTest({
    isShared: true,

    // a faulty source: the header's CPU flags are not the ones it offered
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        invariant(header.warm);

        const move = header.warm.move;

        return buildJsonMoveFrame(MOVE_FRAMES.header, {
          ...header,
          warm: {
            ...header.warm,
            move: { ...move, snapshot: { ...move.snapshot, cpuFlags: 'other-flags' } },
          },
        });
      }),
    ),
  });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toInclude('this host cannot load the memory: the CPU flags differ');
  expect(staged).toBeUndefined();
});

test('it refuses a warm stream whose snapshot record the target cannot load', async () => {
  const ctx = await setupTest({
    isShared: true,

    // a faulty source: the snapshot record names a kernel the move facts do not
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        invariant(header.warm);

        return buildJsonMoveFrame(MOVE_FRAMES.header, {
          ...header,
          warm: { ...header.warm, meta: { ...header.warm.meta, hostKernel: '0.0.1' } },
        });
      }),
    ),
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');

  const kernel = ctx.target.readIdentity().hostKernel;

  expect(status.error).toInclude(
    `the memory snapshot cannot load here: hostKernel changed (0.0.1 → ${kernel})`,
  );

  expect(staged).toBeUndefined();
  expect(readSnapshotMeta(ctx.target.storage.resolveImpPaths(created.id))).toBeNull();
});

test('it fails a warm send whose snapshot record went missing after the prepare', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const plan = await ctx.sourceApp.client.moves.prepare({
    name: 'dev',
    target: await ctx.targetApp.client.moves.facts(),
  });

  invariant(plan.warm);

  const ticket = await ctx.targetApp.client.moves.receive({
    name: 'dev',
    bytes: plan.bytes,
    warm: plan.warm,
  });

  rmSync(ctx.source.storage.resolveImpPaths(created.id).snapshotMeta);

  await ctx.sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  const status = await ctx.waitForMove('dev');

  expect(status.error).toInclude('dev has no memory snapshot to move');
});

test("it installs the target's broker CA once at the first wake after a warm move", async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });
  await ctx.runMove('dev');

  const before = await ctx.target.db
    .selectFrom('imps')
    .select('trust_pending')
    .where('id', '=', created.id)
    .executeTakeFirstOrThrow();

  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  expect(before.trust_pending).toBe(1);

  await waitFor(async () => {
    const after = await ctx.target.db
      .selectFrom('imps')
      .select('trust_pending')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();

    expect(after.trust_pending).toBe(0);
  });
});

test('it refuses a system drive the target lacks whose sum is not its name', async () => {
  const ctx = await setupTest({
    isShared: true,

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

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  // the test drive's bytes are not the data its name hashes
  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');
  const isFree = await isSlotFree(ctx.target.db, created.slot, ctx.target.now());
  const kept = await findImpByName(ctx.source.db, 'dev');

  expect(status.error).toInclude('the system drive does not match its sha256');
  expect(staged).toBeUndefined();
  expect(isFree).toBe(true);
  expect(kept).toMatchObject({ state: 'sleeping', moveState: null });
});

test("it refuses a snapshot that opens a drive off the target's own path, and frees the slot with no abort", async () => {
  const refusals: string[] = [];

  const ctx = await setupTest({
    isShared: true,

    // the source's abort never arrives: the refusal alone frees the slot
    hook: async (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.abort)) {
        throw new Error('the source is gone');
      }

      const response = await forward();

      // what the target answered the stream with, as the source read it
      if (request.url.endsWith(MOVE_PATHS.receive) && !response.ok) {
        const body = await response.clone().text();

        refusals.push(body);
      }

      return response;
    },
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const vmIdentity = ctx.source.storage.resolveImpPaths(created.id).vmIdentity;
  const vm = VmIdentitySchema.parse(JSON.parse(readFileSync(vmIdentity, 'utf8')));

  writeFileSync(vmIdentity, JSON.stringify({ ...vm, systemDrivePath: '/etc/shadow' }));

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');
  const isFree = await isSlotFree(ctx.target.db, created.slot, ctx.target.now());

  expect(refusals).toSatisfyAny((body: string) => body.includes("the snapshot's drive is not at"));
  expect(status.error).toInclude('did not confirm the abort');
  expect(staged).toBeUndefined();
  expect(isFree).toBe(true);
});

test('it commits a warm move whose commit was lost on resume, with a reissued ticket', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
    isShared: true,

    // the network drops the first commit
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('the network dropped the commit'));
      }

      return forward();
    },
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const dropped = await ctx.runMove('dev');
  const ticket = await ctx.targetApp.client.moves.reissue({ name: 'dev' });
  const resumed = await ctx.sourceApp.client.moves.resume({ name: 'dev', ticket: ticket.ticket });
  const moved = await findImpByName(ctx.target.db, 'dev');
  const woken = await ctx.targetApp.client.imps.wake({ name: 'dev' });

  expect(dropped.error).toInclude('dropped the commit');
  expect(resumed.isDone).toBe(true);
  expect(moved).toMatchObject({ slot: created.slot, state: 'sleeping', moveState: null });
  expect(woken.state).toBe('running');
  expect(ctx.target.fake.wakes).toHaveLength(1);
  expect(ctx.commits).toStrictEqual(['dev']);
});

test('it commits a verified warm move warm when the source restarts', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
    isShared: true,

    // the network drops the first commit
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('the network dropped the commit'));
      }

      return forward();
    },
  });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });
  await ctx.runMove('dev');
  await ctx.sourceApp.moves.recover();

  await waitFor(async () => {
    const gone = await findImpByName(ctx.source.db, 'dev');

    expect(gone).toBeUndefined();
  });

  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(moved).toMatchObject({ state: 'sleeping', moveState: null });
});

test('it frees the slot and removes the memory on the target on an abort after the receipt', async () => {
  const ctx = await setupTest({
    isShared: true,

    // the network drops every commit
    hook: (request, forward) =>
      request.url.endsWith(MOVE_PATHS.commit)
        ? Promise.reject(new Error('the network dropped the commit'))
        : forward(),
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });
  await ctx.runMove('dev');
  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const staged = await findImpByName(ctx.target.db, 'dev');
  const isFree = await isSlotFree(ctx.target.db, created.slot, ctx.target.now());

  expect(staged).toBeUndefined();
  expect(isFree).toBe(true);
  expect(existsSync(ctx.target.storage.resolveImpPaths(created.id).snapshotDir)).toBe(false);
});

test('it leaves the imp asleep on the source to wake there after an abort after the receipt', async () => {
  const ctx = await setupTest({
    isShared: true,

    // the network drops every commit
    hook: (request, forward) =>
      request.url.endsWith(MOVE_PATHS.commit)
        ? Promise.reject(new Error('the network dropped the commit'))
        : forward(),
  });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });
  await ctx.runMove('dev');
  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const woken = await ctx.sourceApp.client.imps.wake({ name: 'dev' });

  expect(woken.state).toBe('running');
});

test('it removes the memory and frees the slot of a warm stream cut short with no abort', async () => {
  const ctx = await setupTest({
    isShared: true,
    partBytes: 4096,

    // the source goes quiet past the gap after the first part, and its
    // abort never arrives
    hook: (request, forward, hosts) => {
      if (request.url.endsWith(MOVE_PATHS.abort)) {
        return Promise.reject(new Error('the source is gone'));
      }

      if (request.headers.get(MOVE_PART_HEADER) === '1') {
        hosts.target.advance(61_000);
      }

      return forward();
    },
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  // a disk of many parts
  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'x'.repeat(64 * 1024));

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');
  const isFree = await isSlotFree(ctx.target.db, created.slot, ctx.target.now());

  // the target ended the stream on its own; the source still owes the abort
  expect(status.error).toInclude('did not confirm the abort');
  expect(staged).toBeUndefined();
  expect(isFree).toBe(true);
  expect(existsSync(ctx.target.storage.resolveImpPaths(created.id).snapshotDir)).toBe(false);
});

test('it carries a pending disk grow with a warm move', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const slept = await findImpByName(ctx.source.db, 'dev');

  invariant(slept);

  await updateImpDisk(ctx.source.db, created.id, {
    diskBytes: slept.diskBytes,
    isGrowPending: true,
  });

  await ctx.runMove('dev');

  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(moved?.isDiskGrowPending).toBe(true);
});

test('it grows the guest at the first wake on the target after a warm move with a pending grow', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const slept = await findImpByName(ctx.source.db, 'dev');

  invariant(slept);

  await updateImpDisk(ctx.source.db, created.id, {
    diskBytes: slept.diskBytes,
    isGrowPending: true,
  });

  await ctx.runMove('dev');
  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  const grown = await findImpByName(ctx.target.db, 'dev');

  expect(ctx.target.filesystemGrows).toStrictEqual([
    ctx.target.storage.resolveImpPaths(created.id).disk,
  ]);

  expect(ctx.source.filesystemGrows).toStrictEqual([]);
  expect(grown?.isDiskGrowPending).toBe(false);
});

test('it refuses a warm move of an imp whose tap has a MAC from before slot MACs', async () => {
  const ctx = await setupTest({ isShared: true, readTapMac: () => '02:aa:bb:cc:dd:ee' });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const facts = await ctx.targetApp.client.moves.facts();

  expect(ctx.sourceApp.client.moves.prepare({ name: 'dev', target: facts })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.toInclude('has a MAC from before slot MACs'),
  });
});

test('it refuses a warm move of an imp whose tap a host restart took', async () => {
  const ctx = await setupTest({ isShared: true, readTapMac: () => null });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const facts = await ctx.targetApp.client.moves.facts();

  expect(ctx.sourceApp.client.moves.prepare({ name: 'dev', target: facts })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.toInclude('wake it once first'),
  });
});

test("it removes the target's tap for the slot a warm move lands in", async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });
  await ctx.runMove('dev');

  expect(ctx.target.removedTaps).toContain(`imp${String(created.slot)}`);
});

test('it refuses a warm move of an imp on a private network', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const network = await writeNetwork(ctx.source.db, 'lab');

  invariant(network);

  await writeMember(ctx.source.db, network.id, created.id);

  const facts = await ctx.targetApp.client.moves.facts();

  expect(ctx.sourceApp.client.moves.prepare({ name: 'dev', target: facts })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.toInclude('it is on private networks (lab)'),
  });
});

test('it carries the cold boots with a warm move', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const before = await listColdBoots(ctx.source.db, created.id);

  await ctx.runMove('dev');

  const carried = await listColdBoots(ctx.target.db, created.id);

  expect(before.map((boot) => boot.cause)).toStrictEqual(['start']);
  expect(carried).toStrictEqual(before);
});

test("it adds no cold boot when the target records the carried boot as a memory wake's report of it", async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const before = await listColdBoots(ctx.source.db, created.id);

  const [slept] = before;

  invariant(slept);

  await ctx.runMove('dev');

  // the write a memory wake makes when the agent reports the boot the guest
  // slept in; the stub VMM keeps boot ids per host, so a wake on the target
  // cannot report the source's
  await writeUnknownBoot(ctx.target.db, created.id, slept.bootId, new Date());

  const after = await listColdBoots(ctx.target.db, created.id);

  expect(after).toStrictEqual(before);
});

test('it boots a warm-moved imp cold with the cause wake_fallback when its memory cannot load', async () => {
  const ctx = await setupTest({ isShared: true });

  // each stub VMM numbers its VMs from one, and a boot id follows the
  // number: another imp first keeps dev's boot ids apart on the two hosts
  await ctx.sourceApp.client.imps.create({ name: 'first', image: 'ubuntu' });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });
  await ctx.runMove('dev');

  rmSync(ctx.target.storage.resolveImpPaths(created.id).snapshotMeta, { force: true });

  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  const boots = await listColdBoots(ctx.target.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['wake_fallback', 'start']);
});

test('it clamps a carried boot whose time is ahead of the target to its now', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const [boot] = await listColdBoots(ctx.source.db, created.id);

  invariant(boot);

  await ctx.source.db
    .updateTable('imp_cold_boots')
    .set({ at: ctx.target.now() + 60 * 60 * 1000 })
    .where('boot_id', '=', boot.bootId)
    .execute();

  await ctx.runMove('dev');

  const [carried] = await listColdBoots(ctx.target.db, created.id);

  invariant(carried);

  expect(carried.bootId).toBe(boot.bootId);
  expect(Date.parse(carried.at)).toBeLessThanOrEqual(ctx.target.now());
});
