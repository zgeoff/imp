import { expect, test } from 'bun:test';
import { copyFileSync } from 'node:fs';
import type { ImpEvent } from '@imp/api';
import { findImpByName, updateImpActivity, updateImpExposure } from '../db/imps';
import { listLeases, writeLease } from '../db/leases';
import type { LeaseRecord } from '../db/leases';
import { createIdleLoop } from '../idle/idle-loop';
import type { ImpTest, ImpTestOptions } from '../imps/test-imps';
import { readRejection } from '../read-rejection';
import type { StorageBackend } from '../storage/storage-backend';
import { createXfsBackend } from '../storage/xfs-backend';
import {
  MAX_LEASE_REMAINING_MS,
  MAX_MOVED_LEASES,
  MOVE_PATHS,
  MoveOfferReplySchema,
} from './move-header';
import { createUbuntuImage, setupMoveHosts } from './test-moves';
import type { FetchHook } from './test-moves';

// the source's and the target's clocks, an hour apart: a lease's end on the
// target follows the target's own clock
const SOURCE_CLOCK_MS = Date.parse('2026-10-03T12:00:00.000Z');
const TARGET_CLOCK_MS = SOURCE_CLOCK_MS + 60 * 60 * 1000;

// a tailnet node's lease from leases.*, which blocks a sleep or stop
const JOB = { principal: 'tailnet:n1', label: 'job', display: 'laptop' };

// root's `hold`, which never blocks one
const HOLD = { principal: 'root', label: 'hold', display: 'root' };

interface LeaseTestOptions {
  readonly hook?: FetchHook;
  readonly isWarm?: boolean;

  // frozen clocks an hour apart, unless the test runs the wall-clock idle loop
  readonly isFrozen?: boolean;
  readonly source?: ImpTestOptions;
  readonly target?: ImpTestOptions;
}

// Two impds and `dev` on the source: running, or asleep for a warm move
async function setupLeaseTest(options: LeaseTestOptions = {}) {
  const isFrozen = options.isFrozen !== false;

  const hosts = await setupMoveHosts({
    isShared: options.isWarm === true,
    ...(options.hook !== undefined && { hook: options.hook }),
    source: { ...(isFrozen && { frozenClockMs: SOURCE_CLOCK_MS }), ...options.source },
    target: { ...(isFrozen && { frozenClockMs: TARGET_CLOCK_MS }), ...options.target },
  });

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  const created = await hosts.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  if (options.isWarm === true) {
    await hosts.sourceApp.client.imps.sleep({ name: 'dev' });
  }

  // a lease on the source that ends `ms` from its now, or never for null
  const writeSourceLease = (owner: Readonly<typeof JOB>, ms: number | null) =>
    writeLeaseOn(hosts.source, created.id, owner, ms);

  const readLeases = (host: Readonly<Pick<ImpTest, 'db' | 'now'>>) =>
    listLeases(host.db, host.now(), [created.id]);

  return { ...hosts, impId: created.id, writeSourceLease, readLeases };
}

function writeLeaseOn(
  host: Readonly<Pick<ImpTest, 'db' | 'now'>>,
  impId: string,
  owner: Readonly<typeof JOB>,
  ms: number | null,
) {
  const at = host.now();

  const lease: LeaseRecord = {
    impId,
    ...owner,
    until: ms === null ? null : new Date(at + ms),
    createdAt: new Date(at),
  };

  return writeLease(host.db, lease, { at, reason: null });
}

// the owner and end of each lease, as a test compares them
function toEnds(leases: readonly LeaseRecord[]) {
  return leases.map((lease) => ({ label: lease.label, until: lease.until }));
}

// XFS on plain files, as the test harness makes it, for a test to wrap
function createCopyingXfs(dataDir: string): StorageBackend {
  return createXfsBackend({
    dataDir,
    cloneFile: (source, target) => {
      copyFileSync(source, target);

      return Promise.resolve();
    },
  });
}

function readMoveRows(ctx: Readonly<Pick<ImpTest, 'db'>>) {
  return ctx.db.selectFrom('move_sends').selectAll().execute();
}

// An offer reply as a target from before moving leases answers it
async function removeKeepsLeases(request: Request, forward: () => Promise<Response>) {
  const response = await forward();

  if (!request.url.endsWith(MOVE_PATHS.offer)) {
    return response;
  }

  const body: unknown = await response.json();

  const { keepsLeases: _dropped, ...older } = MoveOfferReplySchema.parse(body);

  return Response.json(older);
}

test('a stop move of a leased imp without force is LEASED, before it halts or marks anything', async () => {
  await using ctx = await setupLeaseTest();

  await ctx.writeSourceLease(JOB, 600_000);

  const refused = await readRejection(
    ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true }),
  );

  const imp = await findImpByName(ctx.source.db, 'dev');
  const rows = await readMoveRows(ctx.source);

  expect(refused).toMatchObject({ code: 'LEASED' });
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(rows).toEqual([]);

  await ctx.sourceApp.client.imps.sleep({ name: 'dev', force: true });
  await ctx.writeSourceLease(JOB, 600_000);

  const asleep = await readRejection(
    ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true }),
  );

  const slept = await findImpByName(ctx.source.db, 'dev');

  expect(asleep).toMatchObject({ code: 'LEASED' });
  expect(slept).toMatchObject({ state: 'sleeping', moveState: null });
});

test('a forced stop move ends the leases from leases.*, and the hold arrives with its time left', async () => {
  await using ctx = await setupLeaseTest();

  const events: ImpEvent[] = [];

  ctx.source.imps.events.subscribe((event) => {
    events.push(event);
  });

  await ctx.writeSourceLease(JOB, 600_000);
  await ctx.writeSourceLease(HOLD, 300_000);

  const status = await ctx.runMove('dev', true);

  const released = events.find((event) => event.ev === 'ImpChanged' && event.reason === 'released');

  const moved = await findImpByName(ctx.target.db, 'dev');
  const leases = await ctx.readLeases(ctx.target);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(released).toMatchObject({ detail: { released: 1 } });
  expect(toEnds(leases)).toEqual([{ label: 'hold', until: new Date(TARGET_CLOCK_MS + 300_000) }]);
  expect(moved?.holdUntil).toEqual(new Date(TARGET_CLOCK_MS + 300_000));
});

test('a warm move keeps each lease with its time left on the target clock, and its owners', async () => {
  await using ctx = await setupLeaseTest({ isWarm: true });

  await ctx.writeSourceLease(JOB, 600_000);
  await ctx.writeSourceLease({ principal: 'token:abc', label: 'ci', display: 'ci' }, 900_000);
  await ctx.writeSourceLease({ ...HOLD, principal: 'legacy', display: 'legacy' }, null);

  const status = await ctx.runMove('dev');
  const leases = await ctx.readLeases(ctx.target);
  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved).toMatchObject({ state: 'sleeping', moveState: null });

  expect(leases.map((lease) => [lease.principal, lease.label, lease.display, lease.until])).toEqual(
    [
      ['legacy', 'hold', 'legacy', null],
      ['tailnet:n1', 'job', 'laptop', new Date(TARGET_CLOCK_MS + 600_000)],
      ['token:abc', 'ci', 'ci', new Date(TARGET_CLOCK_MS + 900_000)],
    ],
  );

  // the legacy hold has no end
  expect(moved?.holdUntil?.getTime()).toBeGreaterThan(TARGET_CLOCK_MS + 900_000);

  // the same tailnet node renews here; no token of the target is the source's
  const renewed = await ctx.target.imps.renewLease('dev', JOB, 'job', 60);
  const made = await ctx.targetApp.client.tokens.create({ name: 'ci', scope: 'exec' });

  const principal = ctx.target.tokens.authenticate(made.secret)?.principal ?? '';

  const notHeld = await readRejection(
    ctx.target.imps.renewLease('dev', { principal, display: 'ci' }, 'ci', 60),
  );

  expect(renewed.lease.until).toEqual(new Date(TARGET_CLOCK_MS + 600_000));
  expect(notHeld).toMatchObject({ code: 'LEASE_NOT_HELD' });
});

test('a cold move of a stopped imp keeps its hold, and the commit says it is held', async () => {
  await using ctx = await setupLeaseTest();

  const events: ImpEvent[] = [];

  ctx.target.imps.events.subscribe((event) => {
    events.push(event);
  });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.writeSourceLease(HOLD, 300_000);

  const status = await ctx.runMove('dev');
  const leases = await ctx.readLeases(ctx.target);

  await Bun.sleep(10);

  const held = events.find((event) => event.ev === 'ImpChanged' && event.reason === 'held');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(held).toMatchObject({ imp: { name: 'dev', state: 'stopped' } });
  expect(toEnds(leases)).toEqual([{ label: 'hold', until: new Date(TARGET_CLOCK_MS + 300_000) }]);
});

test('each lease ends from when the target read the header; one that ended during the disk is left out', async () => {
  const clock: { advance: (ms: number) => void } = { advance: () => {} };

  // the disk takes 30 s on the target's clock
  const createStorage = (dataDir: string): StorageBackend => {
    const backend = createCopyingXfs(dataDir);

    return {
      ...backend,
      createImpDisk: async (impId, source) => {
        clock.advance(30_000);

        await backend.createImpDisk(impId, source);
      },
    };
  };

  await using ctx = await setupLeaseTest({ target: { createStorage } });

  clock.advance = ctx.target.advance;

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.writeSourceLease(HOLD, 20_000);
  await ctx.writeSourceLease({ ...HOLD, principal: 'tailnet:n1', display: 'laptop' }, 600_000);

  const status = await ctx.runMove('dev');
  const leases = await ctx.readLeases(ctx.target);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(ctx.target.now()).toBe(TARGET_CLOCK_MS + 30_000);
  expect(toEnds(leases)).toEqual([{ label: 'hold', until: new Date(TARGET_CLOCK_MS + 600_000) }]);
});

test('a forced prepare that fails after the halt keeps the leases, and the imp runs again', async () => {
  const failing = { isOn: true };

  // the source cannot open its disk for the count
  const createStorage = (dataDir: string): StorageBackend => {
    const backend = createCopyingXfs(dataDir);

    return {
      ...backend,
      openMoveSource: (impId, checkpointIds, mode) =>
        failing.isOn
          ? Promise.reject(new Error('the disk is unreadable'))
          : backend.openMoveSource(impId, checkpointIds, mode),
    };
  };

  await using ctx = await setupLeaseTest({ source: { createStorage } });

  await ctx.writeSourceLease(JOB, 600_000);

  const refused = await readRejection(
    ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true, force: true }),
  );

  const imp = await findImpByName(ctx.source.db, 'dev');
  const leases = await ctx.readLeases(ctx.source);
  const rows = await readMoveRows(ctx.source);

  expect(refused).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(leases.map((lease) => lease.label)).toEqual(['job']);
  expect(rows).toEqual([]);

  failing.isOn = false;

  const status = await ctx.runMove('dev', true);

  expect(status).toMatchObject({ isDone: true, error: null });
});

test('an older target is refused an imp with only a hold or a legacy hold, before any byte goes', async () => {
  for (const owner of [HOLD, { ...HOLD, principal: 'legacy', display: 'legacy' }]) {
    await using ctx = await setupLeaseTest({ hook: removeKeepsLeases });

    await ctx.writeSourceLease(JOB, 600_000);
    await ctx.writeSourceLease(owner, 300_000);

    const status = await ctx.runMove('dev', true);
    const imp = await findImpByName(ctx.source.db, 'dev');
    const leases = await ctx.readLeases(ctx.source);
    const landed = await findImpByName(ctx.target.db, 'dev');

    // the forced stop ended the job lease; the hold refused the send, and
    // the halted imp runs again
    expect(status.error).toContain('predates moving leases');
    expect(status.sentBytes).toBe(0);
    expect(imp).toMatchObject({ state: 'running', moveState: null });

    expect(leases.map((lease) => [lease.principal, lease.label])).toEqual([
      [owner.principal, 'hold'],
    ]);

    expect(landed).toBeUndefined();
  }
});

test('an older target takes an imp with no lease', async () => {
  await using ctx = await setupLeaseTest({ hook: removeKeepsLeases });

  const status = await ctx.runMove('dev', true);

  expect(status).toMatchObject({ isDone: true, error: null });
});

test('an abort after the receipt keeps the source leases, and the target has none', async () => {
  const lost = { commits: 1 };

  await using ctx = await setupLeaseTest({
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('the network dropped the commit'));
      }

      return forward();
    },
  });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.writeSourceLease(HOLD, 300_000);
  await ctx.runMove('dev');

  const staged = await ctx.readLeases(ctx.target);

  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const kept = await ctx.readLeases(ctx.source);
  const left = await ctx.target.db.selectFrom('imp_leases').selectAll().execute();

  // the staged imp showed its lease; the abort took both
  expect(staged.map((lease) => lease.label)).toEqual(['hold']);
  expect(toEnds(kept)).toEqual([{ label: 'hold', until: new Date(SOURCE_CLOCK_MS + 300_000) }]);
  expect(left).toEqual([]);
});

test("a target restart removes a staged imp's leases with it, and keeps a committed imp's", async () => {
  await using ctx = await setupLeaseTest({
    hook: (request, forward) =>
      request.url.endsWith(MOVE_PATHS.commit)
        ? Promise.reject(new Error('the network dropped the commit'))
        : forward(),
  });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.writeSourceLease(HOLD, 300_000);
  await ctx.runMove('dev');

  const staged = await ctx.readLeases(ctx.target);

  // a crash before the receipt: the stream counts as cut short
  await ctx.target.db.updateTable('move_tickets').set({ receipt: null }).execute();
  await ctx.targetApp.moves.recover();

  const gone = await findImpByName(ctx.target.db, 'dev');
  const left = await ctx.target.db.selectFrom('imp_leases').selectAll().execute();

  expect(staged.map((lease) => lease.label)).toEqual(['hold']);
  expect(gone).toBeUndefined();
  expect(left).toEqual([]);
});

test('a target restart after the commit keeps the leases', async () => {
  await using ctx = await setupLeaseTest();

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.writeSourceLease(HOLD, 300_000);
  await ctx.runMove('dev');
  await ctx.targetApp.moves.recover();

  const leases = await ctx.readLeases(ctx.target);

  expect(toEnds(leases)).toEqual([{ label: 'hold', until: new Date(TARGET_CLOCK_MS + 300_000) }]);
});

test('a lease call on a marked imp fails with MOVING', async () => {
  await using ctx = await setupLeaseTest();

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const calls = [
    ctx.sourceApp.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 }),
    ctx.sourceApp.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 60 }),
    ctx.sourceApp.client.leases.release({ name: 'dev', label: 'job' }),
    ctx.sourceApp.client.imps.hold({ name: 'dev', seconds: 60 }),
  ];

  const refusals = await Promise.all(calls.map((call) => readRejection(call)));

  expect(refusals).toMatchObject(calls.map(() => ({ code: 'MOVING' })));
});

test("after a warm commit the target's idle loop and governor leave the leased imp awake", async () => {
  // the idle loop reads the wall clock, so these clocks run
  await using ctx = await setupLeaseTest({
    isWarm: true,
    isFrozen: false,
    target: { env: { IMP_IDLE_TIMEOUT_S: '1', IMP_RAM_BUDGET_MIB: '3000' } },
  });

  await ctx.writeSourceLease(JOB, 600_000);
  await ctx.runMove('dev');
  await ctx.targetApp.client.imps.wake({ name: 'dev' });

  // idle long past the timeout: only the lease keeps it awake
  await updateImpActivity(ctx.target.db, ctx.impId, new Date(Date.now() - 60_000));

  const idle = createIdleLoop({
    config: ctx.target.config,
    db: ctx.target.db,
    imps: ctx.target.imps,
    log: () => {},
  });

  await idle.runCheck();

  // room for 2900 MiB needs dev asleep, which its lease forbids
  const refused = await readRejection(
    ctx.target.governor.admit({ id: 'x', name: 'x', reserveMib: 2900, memoryMib: 2900 }),
  );

  const imp = await findImpByName(ctx.target.db, 'dev');

  expect(refused).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(imp?.state).toBe('running');
});

test('an expose that lands between the halt and the mark undoes the mark, keeps the leases, and runs the imp', async () => {
  const hooks = { onOpen: () => Promise.resolve() };

  // the count opens the disk after the halt and before the mark
  const createStorage = (dataDir: string): StorageBackend => {
    const backend = createCopyingXfs(dataDir);

    return {
      ...backend,
      openMoveSource: async (impId, checkpointIds, mode) => {
        await hooks.onOpen();

        return backend.openMoveSource(impId, checkpointIds, mode);
      },
    };
  };

  await using ctx = await setupLeaseTest({ source: { createStorage } });

  hooks.onOpen = async () => {
    await updateImpExposure(ctx.source.db, ctx.impId, { auth: 'none', user: null, hash: null });
  };

  await ctx.writeSourceLease(JOB, 600_000);

  const refused = await readRejection(
    ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true, force: true }),
  );

  const imp = await findImpByName(ctx.source.db, 'dev');
  const leases = await ctx.readLeases(ctx.source);
  const rows = await readMoveRows(ctx.source);

  expect(refused).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(leases.map((lease) => lease.label)).toEqual(['job']);
  expect(rows).toEqual([]);
});

test('an imp with more leases than a move carries is refused at the offer, and runs again', async () => {
  await using ctx = await setupLeaseTest();

  // holds, which a forced stop keeps
  for (let index = 0; index <= MAX_MOVED_LEASES; index += 1) {
    await ctx.writeSourceLease({ ...HOLD, principal: `tailnet:n${String(index)}` }, 600_000);
  }

  const status = await ctx.runMove('dev', true);
  const imp = await findImpByName(ctx.source.db, 'dev');
  const landed = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('more than a move carries');
  expect(status.sentBytes).toBe(0);
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(landed).toBeUndefined();
});

test('a lease whose owner is longer than a header carries is refused at the offer, and the imp runs again', async () => {
  await using ctx = await setupLeaseTest();

  const principal = `tailnet-user:${'x'.repeat(300)}@example.com`;

  await ctx.writeSourceLease({ ...HOLD, principal }, 600_000);

  const status = await ctx.runMove('dev', true);
  const imp = await findImpByName(ctx.source.db, 'dev');
  const leases = await ctx.readLeases(ctx.source);
  const landed = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('a move cannot carry');
  expect(status.sentBytes).toBe(0);
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(leases.map((lease) => lease.principal)).toEqual([principal]);
  expect(landed).toBeUndefined();
});

test('a hold that ends past 100 years moves with 100 years left', async () => {
  await using ctx = await setupLeaseTest();

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.writeSourceLease(HOLD, MAX_LEASE_REMAINING_MS + 60_000);

  const status = await ctx.runMove('dev');
  const leases = await ctx.readLeases(ctx.target);

  expect(status).toMatchObject({ isDone: true, error: null });

  expect(toEnds(leases)).toEqual([
    { label: 'hold', until: new Date(TARGET_CLOCK_MS + MAX_LEASE_REMAINING_MS) },
  ]);
});
