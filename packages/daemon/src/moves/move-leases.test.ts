import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import type { ImpEvent } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { findImpByName, updateImpActivity, updateImpExposure } from '../db/imps';
import { listLeases, writeLease } from '../db/leases';
import { createIdleLoop } from '../idle/idle-loop';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildMockLeaseRecord } from '../test-utils/build-mock-lease-record';
import { buildStubOlderMoveTarget } from '../test-utils/build-stub-older-move-target';
import { buildStubStorageFaults } from '../test-utils/build-stub-storage-faults';
import { MOVE_PART_HEADER, MOVE_PATHS } from './move-header';
import { createUbuntuImage, setupMoveHosts } from './test-moves';
import type { MoveHostsOptions } from './test-moves';

// Two impds whose frozen clocks are an hour apart, so a lease's end on the
// target shows whose clock it followed. The source's storage is XFS on plain
// files, as the harness's, with faults a test can set.
async function setupTest(config: Pick<MoveHostsOptions, 'hook' | 'isShared' | 'partBytes'> = {}) {
  const sourceFaults = buildStubStorageFaults();

  const hosts = await setupMoveHosts({
    ...config,
    source: {
      frozenClockMs: Date.parse('2026-10-03T12:00:00.000Z'),
      createStorage: (dataDir) =>
        sourceFaults.wrap(
          createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
        ),
    },
    target: { frozenClockMs: Date.parse('2026-10-03T13:00:00.000Z') },
  });

  // the image a create on either host reads
  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  return { ...hosts, sourceFaults };
}

test('it refuses a stop move of a leased running imp without force, before it halts or marks it', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });

  const prepared = ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true });

  expect(prepared).rejects.toMatchObject({ code: 'LEASED' });

  const imp = await findImpByName(ctx.source.db, 'dev');
  const sends = await ctx.source.db.selectFrom('move_sends').selectAll().execute();

  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(sends).toStrictEqual([]);
});

test('it refuses a stop move of a leased sleeping imp without force, and leaves it asleep', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });

  const prepared = ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true });

  expect(prepared).rejects.toMatchObject({ code: 'LEASED' });

  const imp = await findImpByName(ctx.source.db, 'dev');

  expect(imp).toMatchObject({ state: 'sleeping', moveState: null });
});

test('it ends the leases from leases.* on a forced stop move, and moves the hold with its time left', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();
  const targetStart = ctx.target.now();
  const events: ImpEvent[] = [];

  const unsubscribe = ctx.source.imps.events.subscribe((event) => {
    events.push(event);
  });

  onTestFinished(unsubscribe);

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  const hold = buildMockLeaseRecord({
    impId: created.id,
    principal: 'root',
    label: 'hold',
    display: 'root',
    until: new Date(sourceNow + 300_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });
  await writeLease(ctx.source.db, hold, { at: sourceNow, reason: null });

  const status = await ctx.runMove('dev', true);
  const leases = await listLeases(ctx.target.db, ctx.target.now(), [created.id]);
  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });

  expect(events).toPartiallyContain({
    ev: 'ImpChanged',
    reason: 'released',
    detail: { released: 1 },
  });

  expect(leases).toMatchObject([{ label: 'hold', until: new Date(targetStart + 300_000) }]);
  expect(moved?.holdUntil).toStrictEqual(new Date(targetStart + 300_000));
});

test('it keeps each lease of a warm move, with its owner and its time left on the target clock', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();
  const targetStart = ctx.target.now();

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  const ci = buildMockLeaseRecord({
    impId: created.id,
    principal: 'token:abc',
    label: 'ci',
    display: 'ci',
    until: new Date(sourceNow + 900_000),
    createdAt: new Date(sourceNow),
  });

  const legacy = buildMockLeaseRecord({
    impId: created.id,
    principal: 'legacy',
    label: 'hold',
    display: 'legacy',
    until: null,
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });
  await writeLease(ctx.source.db, ci, { at: sourceNow, reason: null });
  await writeLease(ctx.source.db, legacy, { at: sourceNow, reason: null });

  const status = await ctx.runMove('dev');
  const moved = await findImpByName(ctx.target.db, 'dev');
  const leases = await listLeases(ctx.target.db, ctx.target.now(), [created.id]);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved).toMatchObject({ state: 'sleeping', moveState: null });

  expect(leases).toMatchObject([
    { principal: 'legacy', label: 'hold', display: 'legacy', until: null },
    {
      principal: 'tailnet:n1',
      label: 'job',
      display: 'laptop',
      until: new Date(targetStart + 600_000),
    },
    { principal: 'token:abc', label: 'ci', display: 'ci', until: new Date(targetStart + 900_000) },
  ]);
});

test('it holds a warm-moved imp past a century while its legacy hold has no end', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();
  const targetStart = ctx.target.now();

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const legacy = buildMockLeaseRecord({
    impId: created.id,
    principal: 'legacy',
    label: 'hold',
    display: 'legacy',
    until: null,
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, legacy, { at: sourceNow, reason: null });

  await ctx.runMove('dev');

  const moved = await findImpByName(ctx.target.db, 'dev');

  invariant(moved?.holdUntil);

  expect(moved.holdUntil).toBeAfter(new Date(targetStart + 100 * 365 * 24 * 60 * 60 * 1000));
});

test('it lets the same tailnet node renew its warm-moved lease on the target', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();
  const targetStart = ctx.target.now();

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });

  await ctx.runMove('dev');

  const holder = { principal: 'tailnet:n1', display: 'laptop' };

  const renewed = await ctx.target.imps.renewLease('dev', holder, 'job', 60);

  expect(renewed.lease.until).toStrictEqual(new Date(targetStart + 600_000));
});

test("it refuses a target token the warm-moved lease of the source's token", async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const ci = buildMockLeaseRecord({
    impId: created.id,
    principal: 'token:abc',
    label: 'ci',
    display: 'ci',
    until: new Date(sourceNow + 900_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, ci, { at: sourceNow, reason: null });

  await ctx.runMove('dev');

  const made = await ctx.targetApp.client.tokens.create({ name: 'ci', scope: 'exec' });

  const caller = ctx.target.tokens.authenticate(made.secret);

  invariant(caller?.principal);

  const holder = { principal: caller.principal, display: 'ci' };

  expect(ctx.target.imps.renewLease('dev', holder, 'ci', 60)).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });
});

test('it keeps the hold of a stopped imp on a cold move, and says the commit is held', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();
  const targetStart = ctx.target.now();
  const events: ImpEvent[] = [];

  const unsubscribe = ctx.target.imps.events.subscribe((event) => {
    events.push(event);
  });

  onTestFinished(unsubscribe);

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const hold = buildMockLeaseRecord({
    impId: created.id,
    principal: 'root',
    label: 'hold',
    display: 'root',
    until: new Date(sourceNow + 300_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, hold, { at: sourceNow, reason: null });

  const status = await ctx.runMove('dev');
  const leases = await listLeases(ctx.target.db, ctx.target.now(), [created.id]);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(leases).toMatchObject([{ label: 'hold', until: new Date(targetStart + 300_000) }]);

  await waitFor(() => {
    expect(events).toPartiallyContain({
      ev: 'ImpChanged',
      reason: 'held',
      imp: expect.objectContaining({ name: 'dev', state: 'stopped' }) as unknown,
    });
  });
});

test('it ends each lease from when the target read the header, and leaves out one that ended during the disk', async () => {
  const ctx = await setupTest({
    partBytes: 4096,

    // the disk's later parts come 30 s after the header, on the target's clock
    hook: (request, forward, hosts) => {
      if (request.headers.get(MOVE_PART_HEADER) === '1') {
        hosts.target.advance(30_000);
      }

      return forward();
    },
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();
  const headerAt = ctx.target.now();

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  // a disk of many parts, so the clock moves after the header
  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'x'.repeat(64 * 1024));

  const short = buildMockLeaseRecord({
    impId: created.id,
    principal: 'root',
    label: 'hold',
    display: 'root',
    until: new Date(sourceNow + 20_000),
    createdAt: new Date(sourceNow),
  });

  const long = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'hold',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, short, { at: sourceNow, reason: null });
  await writeLease(ctx.source.db, long, { at: sourceNow, reason: null });

  const status = await ctx.runMove('dev');
  const leases = await listLeases(ctx.target.db, ctx.target.now(), [created.id]);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(ctx.target.now()).toBe(headerAt + 30_000);

  expect(leases).toMatchObject([
    { principal: 'tailnet:n1', label: 'hold', until: new Date(headerAt + 600_000) },
  ]);
});

test('it keeps the leases and runs the imp again when a forced prepare fails after the halt', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });

  // the count after the halt cannot open the disk
  ctx.sourceFaults.failOnce('openMoveSource', new Error('the disk is unreadable'));

  const prepared = ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true, force: true });

  expect(prepared).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const imp = await findImpByName(ctx.source.db, 'dev');
  const leases = await listLeases(ctx.source.db, ctx.source.now(), [created.id]);
  const sends = await ctx.source.db.selectFrom('move_sends').selectAll().execute();

  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(leases).toMatchObject([{ label: 'job' }]);
  expect(sends).toStrictEqual([]);
});

test('it moves the imp once the fault that failed its forced prepare is gone', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });

  // one count after the halt cannot open the disk; the next can
  ctx.sourceFaults.failOnce('openMoveSource', new Error('the disk is unreadable'));

  const failed = ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true, force: true });

  expect(failed).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const status = await ctx.runMove('dev', true);

  expect(status).toMatchObject({ isDone: true, error: null });
});

test.each([
  ['a hold', 'root', 'root'],
  ['a legacy hold', 'legacy', 'legacy'],
])(
  'it refuses an older target an imp with %s, before any byte goes',
  async (_hold, principal, display) => {
    // a target from before moving leases
    const ctx = await setupTest({ hook: buildStubOlderMoveTarget('keepsLeases') });
    const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

    const sourceNow = ctx.source.now();

    const job = buildMockLeaseRecord({
      impId: created.id,
      principal: 'tailnet:n1',
      label: 'job',
      display: 'laptop',
      until: new Date(sourceNow + 600_000),
      createdAt: new Date(sourceNow),
    });

    const hold = buildMockLeaseRecord({
      impId: created.id,
      principal,
      label: 'hold',
      display,
      until: new Date(sourceNow + 300_000),
      createdAt: new Date(sourceNow),
    });

    await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });
    await writeLease(ctx.source.db, hold, { at: sourceNow, reason: null });

    const status = await ctx.runMove('dev', true);
    const imp = await findImpByName(ctx.source.db, 'dev');
    const leases = await listLeases(ctx.source.db, ctx.source.now(), [created.id]);
    const landed = await findImpByName(ctx.target.db, 'dev');

    // the forced stop ended the job lease; the hold refused the send, and the
    // halted imp runs again
    expect(status.error).toInclude('predates moving leases');
    expect(status.sentBytes).toBe(0);
    expect(imp).toMatchObject({ state: 'running', moveState: null });
    expect(leases).toMatchObject([{ principal, label: 'hold' }]);
    expect(landed).toBeUndefined();
  },
);

test('it moves an imp with no lease to an older target', async () => {
  // a target from before moving leases
  const ctx = await setupTest({ hook: buildStubOlderMoveTarget('keepsLeases') });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const status = await ctx.runMove('dev', true);

  expect(status).toMatchObject({ isDone: true, error: null });
});

test('it keeps the source leases and leaves the target none on an abort after the receipt', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
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

  const sourceNow = ctx.source.now();

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const hold = buildMockLeaseRecord({
    impId: created.id,
    principal: 'root',
    label: 'hold',
    display: 'root',
    until: new Date(sourceNow + 300_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, hold, { at: sourceNow, reason: null });

  await ctx.runMove('dev');

  // the staged imp shows its lease until the abort
  const staged = await listLeases(ctx.target.db, ctx.target.now(), [created.id]);

  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const kept = await listLeases(ctx.source.db, ctx.source.now(), [created.id]);
  const left = await ctx.target.db.selectFrom('imp_leases').selectAll().execute();

  expect(staged).toMatchObject([{ label: 'hold' }]);
  expect(kept).toMatchObject([{ label: 'hold', until: new Date(sourceNow + 300_000) }]);
  expect(left).toStrictEqual([]);
});

test("it removes a staged imp's leases with it when the target restarts before the receipt", async () => {
  const ctx = await setupTest({
    // the network drops every commit
    hook: (request, forward) =>
      request.url.endsWith(MOVE_PATHS.commit)
        ? Promise.reject(new Error('the network dropped the commit'))
        : forward(),
  });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const hold = buildMockLeaseRecord({
    impId: created.id,
    principal: 'root',
    label: 'hold',
    display: 'root',
    until: new Date(sourceNow + 300_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, hold, { at: sourceNow, reason: null });

  await ctx.runMove('dev');

  const staged = await listLeases(ctx.target.db, ctx.target.now(), [created.id]);

  // a crash before the receipt: the stream counts as cut short
  await ctx.target.db.updateTable('move_tickets').set({ receipt: null }).execute();
  await ctx.targetApp.moves.recover();

  const gone = await findImpByName(ctx.target.db, 'dev');
  const left = await ctx.target.db.selectFrom('imp_leases').selectAll().execute();

  expect(staged).toMatchObject([{ label: 'hold' }]);
  expect(gone).toBeUndefined();
  expect(left).toStrictEqual([]);
});

test('it keeps the leases of a committed imp when the target restarts', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();
  const targetStart = ctx.target.now();

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const hold = buildMockLeaseRecord({
    impId: created.id,
    principal: 'root',
    label: 'hold',
    display: 'root',
    until: new Date(sourceNow + 300_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, hold, { at: sourceNow, reason: null });

  await ctx.runMove('dev');
  await ctx.targetApp.moves.recover();

  const leases = await listLeases(ctx.target.db, ctx.target.now(), [created.id]);

  expect(leases).toMatchObject([{ label: 'hold', until: new Date(targetStart + 300_000) }]);
});

test('it refuses a lease acquire on a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const acquired = ctx.sourceApp.client.leases.acquire({
    name: 'dev',
    label: 'job',
    ttlSeconds: 60,
  });

  expect(acquired).rejects.toMatchObject({ code: 'MOVING' });
});

test('it refuses a lease renew on a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const renewed = ctx.sourceApp.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 60 });

  expect(renewed).rejects.toMatchObject({ code: 'MOVING' });
});

test('it refuses a lease release on a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const released = ctx.sourceApp.client.leases.release({ name: 'dev', label: 'job' });

  expect(released).rejects.toMatchObject({ code: 'MOVING' });
});

test('it refuses a hold on a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const held = ctx.sourceApp.client.imps.hold({ name: 'dev', seconds: 60 });

  expect(held).rejects.toMatchObject({ code: 'MOVING' });
});

test("it leaves a warm-moved leased imp awake through the target's idle loop", async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });

  await ctx.runMove('dev');
  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  // idle for a day: only the lease keeps it awake
  const lastActive = new Date(ctx.target.now() - 86_400_000);

  await updateImpActivity(ctx.target.db, created.id, lastActive);

  const idle = createIdleLoop({
    config: ctx.target.config,
    db: ctx.target.db,
    imps: ctx.target.imps,
    log: () => {},
    now: ctx.target.now,
  });

  await idle.runCheck();

  const imp = await findImpByName(ctx.target.db, 'dev');

  expect(imp?.state).toBe('running');
});

test('it refuses a RAM admission that needs a warm-moved leased imp asleep on the target', async () => {
  const ctx = await setupTest({ isShared: true });
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });

  await ctx.runMove('dev');
  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  // room for all but 100 MiB of the budget needs dev's RAM back
  const reserveMib = ctx.target.config.ramBudgetMib - 100;

  const admitted = ctx.target.governor.admit({
    id: 'x',
    name: 'x',
    reserveMib,
    memoryMib: reserveMib,
  });

  expect(admitted).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
});

test('it undoes the mark, keeps the leases and runs the imp when an expose lands between the halt and the mark', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  const job = buildMockLeaseRecord({
    impId: created.id,
    principal: 'tailnet:n1',
    label: 'job',
    display: 'laptop',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, job, { at: sourceNow, reason: null });

  // the expose lands while the halt's stop is held, after prepare's own check
  const halt = ctx.source.fake.hold('stop');
  const prepared = ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true, force: true });

  await halt.reached;
  await updateImpExposure(ctx.source.db, created.id, { auth: 'none', user: null, hash: null });

  halt.release();

  expect(prepared).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

  const imp = await findImpByName(ctx.source.db, 'dev');
  const leases = await listLeases(ctx.source.db, ctx.source.now(), [created.id]);
  const sends = await ctx.source.db.selectFrom('move_sends').selectAll().execute();

  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(leases).toMatchObject([{ label: 'job' }]);
  expect(sends).toStrictEqual([]);
});

test('it refuses at the offer an imp with more leases than a move carries, and runs it again', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();

  // 1025 holds, one past the most a move carries; a forced stop keeps holds
  const holds = Array.from({ length: 1025 }, (_unused, index) =>
    buildMockLeaseRecord({
      impId: created.id,
      principal: `tailnet:n${String(index)}`,
      label: 'hold',
      display: 'root',
      until: new Date(sourceNow + 600_000),
      createdAt: new Date(sourceNow),
    }),
  );

  await Promise.all(
    holds.map((hold) => writeLease(ctx.source.db, hold, { at: sourceNow, reason: null })),
  );

  const status = await ctx.runMove('dev', true);
  const imp = await findImpByName(ctx.source.db, 'dev');
  const landed = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toInclude('more than a move carries');
  expect(status.sentBytes).toBe(0);
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(landed).toBeUndefined();
});

test('it refuses at the offer a lease whose owner is longer than a header carries, and runs the imp again', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();
  const principal = `tailnet-user:${'x'.repeat(300)}@example.com`;

  const hold = buildMockLeaseRecord({
    impId: created.id,
    principal,
    label: 'hold',
    display: 'root',
    until: new Date(sourceNow + 600_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, hold, { at: sourceNow, reason: null });

  const status = await ctx.runMove('dev', true);
  const imp = await findImpByName(ctx.source.db, 'dev');
  const leases = await listLeases(ctx.source.db, ctx.source.now(), [created.id]);
  const landed = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toInclude('a move cannot carry');
  expect(status.sentBytes).toBe(0);
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(leases).toMatchObject([{ principal }]);
  expect(landed).toBeUndefined();
});

test('it moves a hold that ends past 100 years with 100 years left', async () => {
  const ctx = await setupTest();
  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const sourceNow = ctx.source.now();
  const targetStart = ctx.target.now();
  const centuryMs = 100 * 365 * 24 * 60 * 60 * 1000;

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const hold = buildMockLeaseRecord({
    impId: created.id,
    principal: 'root',
    label: 'hold',
    display: 'root',
    until: new Date(sourceNow + centuryMs + 60_000),
    createdAt: new Date(sourceNow),
  });

  await writeLease(ctx.source.db, hold, { at: sourceNow, reason: null });

  const status = await ctx.runMove('dev');
  const leases = await listLeases(ctx.target.db, ctx.target.now(), [created.id]);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(leases).toMatchObject([{ label: 'hold', until: new Date(targetStart + centuryMs) }]);
});
