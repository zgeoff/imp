import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createImage, findImageByName } from '../db/images';
import { findImpByName, updateImpExposure, updateImpMove } from '../db/imps';
import { TEST_TOKEN, buildTestApp } from '../imps/test-imps';
import type { ImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';
import { buildImagePaths } from '../storage/data-layout';
import type { StorageBackend } from '../storage/storage-backend';
import { createZfsBackend } from '../storage/zfs/zfs-backend';
import { createFakeZfs } from '../test-utils/build-stub-zfs';
import type { FakeZfs } from '../test-utils/build-stub-zfs';
import { MOVE_PART_HEADER, MOVE_PATHS, MoveOfferReplySchema } from './move-header';
import { ReceiptSchema, buildTicketHeader } from './move-tickets';
import { SOURCE_PEER, TARGET_URL, createUbuntuImage, setupMoveHosts } from './test-moves';
import type { FetchHook } from './test-moves';

async function waitUntil(isDone: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    const isReady = await isDone();

    if (isReady) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error('waited 5 s in vain');
}

interface MoveTestOptions {
  readonly hasImage?: boolean;
  readonly partBytes?: number;
}

// a stopped `dev` on the source, with a checkpoint and a disk changed since
async function setupMoveTest(hook?: FetchHook, options: MoveTestOptions = {}) {
  const hosts = await setupMoveHosts({
    ...(hook !== undefined && { hook }),
    ...(options.partBytes !== undefined && { partBytes: options.partBytes }),
  });

  await createUbuntuImage(hosts.source);

  if (options.hasImage !== false) {
    await createUbuntuImage(hosts.target);
  }

  const created = await hosts.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await hosts.sourceApp.client.imps.stop({ name: 'dev' });

  const disk = hosts.source.storage.resolveImpPaths(created.id).disk;

  writeFileSync(disk, 'hello');

  await hosts.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  writeFileSync(disk, 'world');

  return {
    ...hosts,
    impId: created.id,
    runMove: () => hosts.runMove('dev'),
    runMoveWith: (stop: boolean) => hosts.runMove('dev', stop),
    waitForMove: () => hosts.waitForMove('dev'),
  };
}

test('a stopped imp moves with its id, its checkpoints and its disk', async () => {
  await using ctx = await setupMoveTest();

  const status = await ctx.runMove();
  const moved = await ctx.targetApp.client.imps.get({ name: 'dev' });
  const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });
  const left = await findImpByName(ctx.source.db, 'dev');

  const disk = ctx.target.storage.resolveImpPaths(ctx.impId).disk;

  const source = await ctx.target.storage.openMoveSource(
    ctx.impId,
    checkpoints.map((checkpoint) => checkpoint.id),
    'files',
  );

  const checkpointDisk = source.kind === 'files' ? source.checkpointPaths[0] : undefined;

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved).toMatchObject({ id: ctx.impId, state: 'stopped' });
  expect(moved.move).toBeUndefined();
  expect(checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['one']);
  expect(readFileSync(disk, 'utf8').startsWith('world')).toBe(true);
  expect(readFileSync(checkpointDisk ?? '', 'utf8').startsWith('hello')).toBe(true);
  expect(left).toBeUndefined();
  expect(ctx.commits).toEqual(['dev']);
});

test('a marked imp fails fast with MOVING and Retry-After, and an abort before the stream undoes the mark', async () => {
  await using ctx = await setupMoveTest();

  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const start = await readRejection(ctx.sourceApp.client.imps.start({ name: 'dev' }));
  const destroy = await readRejection(ctx.sourceApp.client.imps.destroy({ name: 'dev' }));

  const resize = await readRejection(
    ctx.sourceApp.client.imps.resizeDisk({ name: 'dev', diskMib: 2048 }),
  );

  const checkpoint = await readRejection(ctx.sourceApp.client.checkpoints.create({ name: 'dev' }));
  const listed = await ctx.sourceApp.client.imps.get({ name: 'dev' });

  const raw = await ctx.sourceApp.app.handle(
    new Request('http://impd.test/rpc/imps/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'dev' } }),
    }),
  );

  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const started = await ctx.sourceApp.client.imps.start({ name: 'dev' });

  for (const refused of [start, destroy, resize, checkpoint]) {
    expect(refused).toMatchObject({ code: 'MOVING', status: 409, data: { retryAfterS: 30 } });
  }

  expect(listed.move).toBe('sending');
  expect(raw.status).toBe(409);
  expect(raw.headers.get('retry-after')).toBe('30');
  expect(started.state).toBe('running');

  // nothing reached the target, so it counted nothing
  expect(ctx.commits).toEqual([]);
});

test('a public imp is refused a move, and a marked imp refuses an exposure change', async () => {
  await using ctx = await setupMoveTest();

  await updateImpExposure(ctx.source.db, ctx.impId, { auth: 'none', user: null, hash: null });

  const publicPrepare = await readRejection(ctx.sourceApp.client.moves.prepare({ name: 'dev' }));

  await ctx.sourceApp.client.imps.unexpose({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const unexpose = await readRejection(ctx.sourceApp.client.imps.unexpose({ name: 'dev' }));

  const written = await updateImpExposure(ctx.source.db, ctx.impId, {
    auth: 'none',
    user: null,
    hash: null,
  });

  expect(publicPrepare).toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(unexpose).toMatchObject({ code: 'MOVING' });
  expect(written).toBeUndefined();
});

test('a running imp moves only with stop, which stops it first', async () => {
  await using ctx = await setupMoveTest();

  await ctx.sourceApp.client.imps.start({ name: 'dev' });

  const refused = await readRejection(ctx.sourceApp.client.moves.prepare({ name: 'dev' }));

  await ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true });

  const imp = await ctx.sourceApp.client.imps.get({ name: 'dev' });

  expect(refused).toMatchObject({ code: 'INVALID_STATE' });
  expect(imp).toMatchObject({ state: 'stopped', move: 'sending' });
});

test('a receipt that does not hold leaves the source as it was and the target empty', async () => {
  await using ctx = await setupMoveTest(async (request, forward) => {
    const response = await forward();

    if (!request.url.endsWith(MOVE_PATHS.receive) || response.status !== 200) {
      return response;
    }

    const answer: unknown = await response.json();

    const receipt = ReceiptSchema.parse(answer);

    return Response.json({ ...receipt, mac: '00'.repeat(32) });
  });

  const status = await ctx.runMove();
  const source = await findImpByName(ctx.source.db, 'dev');
  const target = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('not signed with this ticket');
  expect(source?.moveState).toBeNull();
  expect(target).toBeUndefined();
});

test('a send to a target that is gone ends with the mark on, and says so', async () => {
  await using ctx = await setupMoveTest(async (request, forward) => {
    // the abort fails late, so a status read while it goes would show the
    // send's error with the mark not yet settled
    if (request.url.endsWith(MOVE_PATHS.abort)) {
      await Bun.sleep(100);
    }

    if (request.url.endsWith(MOVE_PATHS.receive) || request.url.endsWith(MOVE_PATHS.abort)) {
      throw new TypeError('Unable to connect');
    }

    return forward();
  });

  const status = await ctx.runMove();
  const source = await findImpByName(ctx.source.db, 'dev');

  expect(status.state).toBe('sending');
  expect(status.error).toContain('the target did not confirm the abort');
  expect(source?.moveState).toBe('sending');
});

test('a commit lost after the receipt holds both copies until resume commits', async () => {
  const lost = { commits: 1 };

  await using ctx = await setupMoveTest((request, forward) => {
    if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
      lost.commits -= 1;

      return Promise.reject(new Error('the network dropped the commit'));
    }

    return forward();
  });

  const status = await ctx.runMove();
  const sourceAfter = await findImpByName(ctx.source.db, 'dev');
  const targetAfter = await findImpByName(ctx.target.db, 'dev');
  const wake = await readRejection(ctx.targetApp.client.imps.start({ name: 'dev' }));
  const resumed = await ctx.sourceApp.client.moves.resume({ name: 'dev' });
  const live = await ctx.targetApp.client.imps.start({ name: 'dev' });

  expect(status.error).toContain('dropped the commit');
  expect(sourceAfter?.moveState).toBe('moved');
  expect(targetAfter?.moveState).toBe('receiving');
  expect(wake).toMatchObject({ code: 'MOVING' });
  expect(resumed.isDone).toBe(true);

  const gone = await findImpByName(ctx.source.db, 'dev');

  expect(gone).toBeUndefined();
  expect(live.state).toBe('running');
});

// #167: main counts the received disk on this hook, so a repeat must not
// fire it again
test('a commit whose answer was lost fires onCommitted once, not again on resume', async () => {
  const lost = { answers: 1 };

  await using ctx = await setupMoveTest(async (request, forward) => {
    const response = await forward();

    if (request.url.endsWith(MOVE_PATHS.commit) && lost.answers > 0) {
      lost.answers -= 1;
      throw new Error('the network dropped the answer');
    }

    return response;
  });

  const status = await ctx.runMove();

  expect(status.error).toContain('dropped the answer');
  expect(ctx.commits).toEqual(['dev']);

  const resumed = await ctx.sourceApp.client.moves.resume({ name: 'dev' });

  expect(resumed.isDone).toBe(true);
  expect(ctx.commits).toEqual(['dev']);
});

test('an abort after the target committed destroys the source copy instead', async () => {
  const lost = { answers: 1 };

  await using ctx = await setupMoveTest(async (request, forward) => {
    const response = await forward();

    // the commit lands, but its answer never reaches the source
    if (request.url.endsWith(MOVE_PATHS.commit) && lost.answers > 0) {
      lost.answers -= 1;
      throw new Error('the answer was lost');
    }

    return response;
  });

  await ctx.runMove();

  const aborted = await ctx.sourceApp.client.moves.abort({ name: 'dev' });
  const target = await ctx.targetApp.client.imps.get({ name: 'dev' });

  expect(aborted.isDone).toBe(true);

  const gone = await findImpByName(ctx.source.db, 'dev');

  expect(gone).toBeUndefined();
  expect(target.move).toBeUndefined();

  // the target's one commit counted the disk; the abort counts nothing more
  expect(ctx.commits).toEqual(['dev']);
});

test('a ticket streams once, in a header from the tailnet, and only for its name', async () => {
  await using ctx = await setupMoveTest();

  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const url = `${TARGET_URL}${MOVE_PATHS.receive}`;

  const sendPart = (headers: Readonly<Record<string, string>>, peer = SOURCE_PEER, at = url) =>
    ctx.targetApp.moves.handle(
      new Request(at, { method: 'POST', headers, body: new Uint8Array([9, 0, 0, 0, 0]) }),
      peer,
    );

  const inUrl = await sendPart({}, SOURCE_PEER, `${url}?ticket=${ticket.ticket}`);
  const offTailnet = await sendPart(buildTicketHeader(ticket.ticket), '192.168.1.5');
  const first = await sendPart(buildTicketHeader(ticket.ticket));
  const second = await sendPart(buildTicketHeader(ticket.ticket));

  expect(inUrl.status).toBe(401);
  expect(offTailnet.status).toBe(403);
  expect(first.status).toBe(202);
  expect(second.status).toBe(409);
});

test('a ticket is refused for a name the target has, or a stream past its window', async () => {
  await using ctx = await setupMoveTest();

  await ctx.targetApp.client.imps.create({ name: 'taken', image: 'ubuntu' });

  const taken = await readRejection(
    ctx.targetApp.client.moves.receive({ name: 'taken', bytes: 1 }),
  );

  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1 });

  ctx.target.advance(11 * 60 * 1000);

  const late = await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([1]),
    }),
    SOURCE_PEER,
  );

  expect(taken).toMatchObject({ code: 'CONFLICT' });
  expect(late.status).toBe(410);
});

test('a stream longer than its ticket is cut off and leaves nothing on the target', async () => {
  await using ctx = await setupMoveTest();

  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 3 });

  await ctx.sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  const status = await ctx.waitForMove();

  expect(status.error).toContain('longer than its ticket');

  const gone = await findImpByName(ctx.target.db, 'dev');

  expect(gone).toBeUndefined();

  const left = await findImpByName(ctx.source.db, 'dev');

  expect(left?.moveState).toBeNull();
});

test('a peer URL off the tailnet, or a name, is refused before any byte goes', async () => {
  await using ctx = await setupMoveTest();

  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const lan = await readRejection(
    ctx.sourceApp.client.moves.send({ name: 'dev', to: 'http://192.168.1.5:7070', ticket: 'a.b' }),
  );

  const named = await readRejection(
    ctx.sourceApp.client.moves.send({ name: 'dev', to: 'http://imp-b:7070', ticket: 'a.b' }),
  );

  expect(lan).toMatchObject({ code: 'BAD_REQUEST' });
  expect(named).toMatchObject({ code: 'BAD_REQUEST' });
});

test('the image goes along when the target lacks it, and only grants of known secrets carry', async () => {
  await using ctx = await setupMoveTest(undefined, { hasImage: false });

  await ctx.source.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.source.broker.addSecret({ name: 'npm', kind: 'npm', value: 'npm_real' });
  await ctx.source.broker.addGrant('dev', 'gh');
  await ctx.source.broker.addGrant('dev', 'npm');
  await ctx.target.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_other' });

  const status = await ctx.runMove();
  const images = await ctx.targetApp.client.images.list();

  const digest = images.find((image) => image.name === 'ubuntu')?.digest ?? '';
  const image = buildImagePaths(ctx.target.dataDir, digest);

  const grants = await ctx.target.broker.listGrants('dev');

  expect(status).toMatchObject({ isDone: true, error: null });

  // filed under what arrived, never the source's claim
  expect(digest).toStartWith('sha256:');
  expect(digest).not.toBe('sha256:ubuntu');
  expect(readFileSync(image.rootfs, 'utf8').startsWith('rootfs')).toBe(true);
  expect(grants).toEqual(['gh']);
});

test('a template copy keeps its owed identity reset, and its template stays a template', async () => {
  await using ctx = await setupMoveTest(undefined, { hasImage: false });

  await ctx.source.db
    .updateTable('images')
    .set({ source: 'imp', source_imp: 'golden' })
    .where('name', '=', 'ubuntu')
    .execute();

  await ctx.source.db
    .updateTable('imps')
    .set({ identity_reset_pending: 1 })
    .where('id', '=', ctx.impId)
    .execute();

  const status = await ctx.runMove();
  const image = await findImageByName(ctx.target.db, 'ubuntu');
  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(image).toMatchObject({ source: 'imp', sourceImp: 'golden' });
  expect(moved?.isIdentityResetPending).toBe(true);
});

test('an elastic imp keeps its max memory', async () => {
  await using ctx = await setupMoveTest();

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', ctx.impId)
    .execute();

  const status = await ctx.runMove();
  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved).toMatchObject({ memoryMib: 256, maxMemoryMib: 1024 });
});

// a target from before elastic memory: its offer reply has no keepsMaxMemory
async function removeKeepsMaxMemory(
  request: Request,
  forward: () => Promise<Response>,
): Promise<Response> {
  const response = await forward();

  if (!request.url.endsWith(MOVE_PATHS.offer)) {
    return response;
  }

  const body: unknown = await response.json();

  const { keepsMaxMemory: _dropped, ...older } = MoveOfferReplySchema.parse(body);

  return Response.json(older);
}

test('an elastic imp is refused a move to a target that would drop its max memory', async () => {
  await using ctx = await setupMoveTest(removeKeepsMaxMemory);

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', ctx.impId)
    .execute();

  const status = await ctx.runMove();
  const landed = await findImpByName(ctx.target.db, 'dev');
  const source = await findImpByName(ctx.source.db, 'dev');

  // nothing went: the source keeps the imp, unmarked, and the target has none
  expect(status.error).toContain('predates elastic memory');
  expect(status.sentBytes).toBe(0);
  expect(source).toMatchObject({ state: 'stopped', moveState: null, maxMemoryMib: 1024 });
  expect(landed).toBeUndefined();
});

test('a running elastic imp that --stop halted runs again when the target refuses its max memory', async () => {
  await using ctx = await setupMoveTest(removeKeepsMaxMemory);

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', ctx.impId)
    .execute();

  await ctx.sourceApp.client.imps.start({ name: 'dev' });

  const status = await ctx.runMoveWith(true);
  const source = await findImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('predates elastic memory');
  expect(source).toMatchObject({ state: 'running', moveState: null });

  const landed = await findImpByName(ctx.target.db, 'dev');

  expect(landed).toBeUndefined();
});

test('a GC while the stream goes keeps every file the send reads', async () => {
  const hooks: { beforeStream: (() => Promise<unknown>) | null } = { beforeStream: null };

  await using ctx = await setupMoveTest(async (request, forward) => {
    const isFirstPart = request.headers.get(MOVE_PART_HEADER) === '0';

    if (request.url.endsWith(MOVE_PATHS.receive) && isFirstPart) {
      await hooks.beforeStream?.();
    }

    return forward();
  });

  const runs: (readonly unknown[])[] = [];

  hooks.beforeStream = async () => {
    const result = await ctx.sourceApp.client.system.gc({});

    runs.push(result.dropped);
  };

  const status = await ctx.runMove();

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(runs).toEqual([[]]);
});

test('a marked imp refuses grant and egress changes, which the send already read', async () => {
  await using ctx = await setupMoveTest();

  await ctx.source.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const grant = await readRejection(ctx.source.broker.addGrant('dev', 'gh'));

  const policy = await readRejection(
    ctx.source.egress.setPolicy('dev', { mode: 'none', allow: [] }),
  );

  expect(grant).toMatchObject({ code: 'MOVING' });
  expect(policy).toMatchObject({ code: 'MOVING' });
});

test('a restart undoes a send cut short, and finishes one the target has verified', async () => {
  const lost = { commits: 1 };

  await using ctx = await setupMoveTest((request, forward) => {
    if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
      lost.commits -= 1;

      return Promise.reject(new Error('impd stopped'));
    }

    return forward();
  });

  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });
  await ctx.sourceApp.moves.recover();

  // recovery runs in the background
  await waitUntil(async () => {
    const imp = await findImpByName(ctx.source.db, 'dev');

    return imp?.moveState === null;
  });

  const undone = await findImpByName(ctx.source.db, 'dev');

  await ctx.runMove();
  await ctx.sourceApp.moves.recover();

  await waitUntil(async () => {
    const imp = await findImpByName(ctx.source.db, 'dev');

    return imp === undefined;
  });

  const live = await ctx.targetApp.client.imps.get({ name: 'dev' });

  expect(undone?.moveState).toBeNull();

  const gone = await findImpByName(ctx.source.db, 'dev');

  expect(gone).toBeUndefined();
  expect(live.move).toBeUndefined();
});

test('a target restart removes a stream cut short and tickets never used', async () => {
  await using ctx = await setupMoveTest();

  const staged = await ctx.target.imps.createImp({
    name: 'half',
    image: 'ubuntu',
    moveState: 'receiving',
  });

  const now = ctx.target.now();

  await ctx.target.db
    .insertInto('move_tickets')
    .values({
      id: 'cut',
      secret_sha256: 'x'.repeat(64),
      name: 'half',
      bytes: 1,
      imp_id: staged.id,
      issued_at: now,
      stream_by: now + 1000,
      stream_used_at: now,
      receipt: null,
      commit_until: null,
      committed_at: null,
    })
    .execute();

  await ctx.targetApp.client.moves.receive({ name: 'later', bytes: 1 });

  ctx.target.advance(11 * 60 * 1000);

  await ctx.targetApp.moves.recover();

  const rows = await ctx.target.db.selectFrom('move_tickets').select('id').execute();
  const gone = await findImpByName(ctx.target.db, 'half');

  expect(gone).toBeUndefined();
  expect(rows).toEqual([]);
});

const ZFS_ROOT = 'tank/imp';

// an impd's storage on a fake ZFS pool, and the pool once it is made
function buildFakeZfsHost() {
  const pool: { zfs: FakeZfs | null } = { zfs: null };

  const createStorage = (dataDir: string): StorageBackend => {
    const zfs = createFakeZfs({ root: ZFS_ROOT, rootDir: dataDir });

    pool.zfs = zfs;

    const backend = createZfsBackend({
      dataDir,
      root: ZFS_ROOT,
      run: zfs.run,
      streams: zfs.streams,
      readMounts: zfs.readMounts,
      readModuleVersion: () => '2.2.2-0ubuntu9',
      log: () => {},
    });

    // the fake pool keeps no files: a new disk gets one, as a clone would
    const writeDisk = (impId: string) => {
      const disk = backend.resolveImpPaths(impId).disk;

      if (!existsSync(disk)) {
        writeFileSync(disk, 'disk');
      }
    };

    return {
      ...backend,
      createImpDisk: async (impId, source) => {
        await backend.createImpDisk(impId, source);

        writeDisk(impId);
      },
      receiveMoveSnapshots: async (impId, steps, readStep, buildId) => {
        const received = await backend.receiveMoveSnapshots(impId, steps, readStep, buildId);

        writeDisk(impId);

        return received;
      },
    };
  };

  return { pool, createStorage };
}

// the fake pool keeps no files: the image is a dataset only
async function createZfsImage(host: Readonly<Pick<ImpTest, 'db' | 'dataDir' | 'storage'>>) {
  await host.storage.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  await host.storage.createImage('sha256:ubuntu', () => Promise.resolve());

  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').rootfs, 'rootfs');
  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');

  await createImage(host.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });
}

// two impds, the target on a fake ZFS pool and the source too unless `isSourceXfs`
async function setupZfsMove(options: Readonly<{ hook?: FetchHook; isSourceXfs?: boolean }> = {}) {
  const isSourceXfs = options.isSourceXfs === true;
  const sourceHost = buildFakeZfsHost();
  const targetHost = buildFakeZfsHost();

  const hosts = await setupMoveHosts({
    ...(options.hook !== undefined && { hook: options.hook }),
    ...(!isSourceXfs && { source: { createStorage: sourceHost.createStorage } }),
    target: { createStorage: targetHost.createStorage },
  });

  await (isSourceXfs ? createUbuntuImage(hosts.source) : createZfsImage(hosts.source));
  await createZfsImage(hosts.target);

  if (targetHost.pool.zfs === null) {
    throw new Error('no pool');
  }

  // an XFS source has no pool
  return { ...hosts, sourcePool: sourceHost.pool.zfs, targetPool: targetHost.pool.zfs };
}

test('between two ZFS hosts the disk and its checkpoints go as ZFS streams', async () => {
  await using ctx = await setupZfsMove();

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev', true);
  const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });

  const received = ctx.targetPool.commands.filter((command) => command.startsWith('zfs recv'));

  const moved = await ctx.targetApp.client.imps.get({ name: 'dev' });
  const left = await findImpByName(ctx.source.db, 'dev');

  expect(status.error).toBeNull();
  expect(checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['one']);
  expect(received).toHaveLength(2);

  expect(ctx.targetPool.listSnapshots()).toContain(
    `${ZFS_ROOT}/disks/${moved.id}@${checkpoints[0]?.id ?? ''}`,
  );

  expect(left).toBeUndefined();
});

test('after a move between ZFS hosts, a GC on either host finds nothing to drop or keep', async () => {
  await using ctx = await setupZfsMove();

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev', true);

  const sweeps = [];

  for (const app of [ctx.sourceApp, ctx.targetApp]) {
    const kept = await app.client.system.gc({});
    const retired = await app.client.system.gc({ orphans: true });

    sweeps.push(kept, retired);
  }

  const pools = [ctx.sourcePool, ctx.targetPool].filter((pool) => pool !== null);

  expect(status.error).toBeNull();
  expect(sweeps.map((sweep) => [sweep.dropped, sweep.kept])).toEqual(sweeps.map(() => [[], []]));

  expect(pools.flatMap((pool) => pool.listSnapshots())).not.toContainEqual(
    expect.stringContaining('@mv-'),
  );

  expect(
    pools.flatMap((pool) => pool.listDatasets()).filter((name) => name.includes('/staging/')),
  ).toEqual([]);
});

// the first FILE_END frame's sum, one hex digit changed: a frame is a type
// byte, a 4-byte big-endian length, then the payload
function writeWrongSum(body: Uint8Array): boolean {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

  for (let at = 0; at + 5 <= body.length; at += 5 + view.getUint32(at + 1)) {
    if (body[at] === 4) {
      const sumAt = at + 5 + '{"sha256":"'.length;

      body[sumAt] = body[sumAt] === 0x30 ? 0x31 : 0x30;

      return true;
    }
  }

  return false;
}

test('a ZFS stream whose sum does not match never commits, and the move can go again', async () => {
  const state = { isCorrupted: false };

  await using ctx = await setupZfsMove({
    hook: async (request, forward) => {
      if (state.isCorrupted || request.headers.get(MOVE_PART_HEADER) === null) {
        return forward();
      }

      const read = await request.arrayBuffer();

      const body = new Uint8Array(read);

      state.isCorrupted = writeWrongSum(body);

      const changed = new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body,
      });

      return ctx.targetApp.moves.handle(changed, SOURCE_PEER);
    },
  });

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const failed = await ctx.runMove('dev', true);

  const staged = ctx.targetPool.listDatasets().filter((name) => name.includes('/staging/'));
  const received = ctx.targetPool.commands.filter((command) => command.startsWith('zfs recv'));

  // nothing to clean up: `zfs recv` never saw the stream's end
  const cleaned = ctx.targetPool.commands.filter((command) => command.includes('/staging/mvin-'));

  const absent = await findImpByName(ctx.target.db, 'dev');

  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const retried = await ctx.runMove('dev', true);

  expect(state.isCorrupted).toBe(true);
  expect(failed.error).toContain('the sha256 does not match');
  expect(received).toHaveLength(1);
  expect(staged).toEqual([]);
  expect(cleaned.filter((command) => !command.startsWith('zfs recv'))).toEqual([]);
  expect(absent).toBeUndefined();
  expect(retried).toMatchObject({ isDone: true, error: null });
});

test('an XFS host moves an imp to a ZFS host as files, checkpoints as snapshots', async () => {
  await using ctx = await setupZfsMove({ isSourceXfs: true });

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'hello');

  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');
  const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });

  const disk = readFileSync(ctx.target.storage.resolveImpPaths(created.id).disk, 'utf8');

  expect(status.error).toBeNull();
  expect(disk.startsWith('hello')).toBe(true);

  expect(ctx.targetPool.listSnapshots()).toContain(
    `${ZFS_ROOT}/disks/${created.id}@${checkpoints[0]?.id ?? ''}`,
  );
});

test('a stream longer than 10 minutes goes on while its parts keep coming', async () => {
  const clock: { advance: (ms: number) => void } = { advance: () => {} };

  await using ctx = await setupMoveTest(
    (request, forward) => {
      // 50 s between parts, on the target's clock
      if (request.headers.has(MOVE_PART_HEADER)) {
        clock.advance(50_000);
      }

      return forward();
    },
    { partBytes: 4096 },
  );

  clock.advance = ctx.target.advance;

  writeFileSync(ctx.source.storage.resolveImpPaths(ctx.impId).disk, 'x'.repeat(64 * 1024));

  const status = await ctx.runMove();

  expect(status).toMatchObject({ isDone: true, error: null });
});

test('a part that comes more than 60 s after the last ends the stream', async () => {
  const clock: { advance: (ms: number) => void } = { advance: () => {} };

  await using ctx = await setupMoveTest(
    (request, forward) => {
      if (request.headers.get(MOVE_PART_HEADER) === '1') {
        clock.advance(61_000);
      }

      return forward();
    },
    { partBytes: 4096 },
  );

  clock.advance = ctx.target.advance;

  writeFileSync(ctx.source.storage.resolveImpPaths(ctx.impId).disk, 'x'.repeat(64 * 1024));

  const status = await ctx.runMove();
  const staged = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('came too late');
  expect(staged).toBeUndefined();
});

test('a target that holds the imp unmarked counts as committed', async () => {
  const lost = { commits: 1 };

  await using ctx = await setupMoveTest((request, forward) => {
    if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
      lost.commits -= 1;

      return Promise.reject(new Error('the network dropped the commit'));
    }

    return forward();
  });

  await ctx.runMove();

  // as a crash between the mark and the ticket would have left it
  await updateImpMove(ctx.target.db, ctx.impId, null);

  const aborted = await ctx.sourceApp.client.moves.abort({ name: 'dev' });
  const gone = await findImpByName(ctx.source.db, 'dev');

  expect(aborted.isDone).toBe(true);
  expect(gone).toBeUndefined();
});

test('a commit with the received copy gone is refused, and the source keeps its copy', async () => {
  const lost = { commits: 1 };

  await using ctx = await setupMoveTest((request, forward) => {
    if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
      lost.commits -= 1;

      return Promise.reject(new Error('the network dropped the commit'));
    }

    return forward();
  });

  await ctx.runMove();
  await ctx.target.imps.destroyImp('dev', { isMove: true });

  const refused = await readRejection(ctx.sourceApp.client.moves.resume({ name: 'dev' }));
  const kept = await findImpByName(ctx.source.db, 'dev');

  expect(String(refused)).toContain('the received copy is gone');
  expect(kept?.moveState).toBe('moved');
});

test('a resume and an abort at once leave the imp live on exactly one host', async () => {
  const lost = { commits: 1 };

  await using ctx = await setupMoveTest((request, forward) => {
    if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
      lost.commits -= 1;

      return Promise.reject(new Error('the network dropped the commit'));
    }

    return forward();
  });

  await ctx.runMove();

  await Promise.allSettled([
    ctx.sourceApp.client.moves.resume({ name: 'dev' }),
    ctx.sourceApp.client.moves.abort({ name: 'dev' }),
  ]);

  const source = await findImpByName(ctx.source.db, 'dev');
  const target = await findImpByName(ctx.target.db, 'dev');

  const isMoved = source === undefined && target?.moveState === null;
  const isKept = source?.moveState === null && target === undefined;

  expect(isMoved || isKept).toBe(true);
});

test('a receive takes a token with manage on the whole host', async () => {
  await using ctx = await setupMoveTest();

  const made = await ctx.targetApp.client.tokens.create({
    name: 'mover',
    scope: 'manage',
    imps: ['dev'],
  });

  const scoped = buildTestApp(ctx.target, ctx.target, made.secret);

  const receive = await readRejection(scoped.client.moves.receive({ name: 'dev', bytes: 1 }));
  const reissue = await readRejection(scoped.client.moves.reissue({ name: 'dev' }));

  expect(receive).toMatchObject({ code: 'FORBIDDEN' });
  expect(reissue).toMatchObject({ code: 'FORBIDDEN' });
});

test('a marked imp refuses an exec, and each /move step is in the audit log', async () => {
  await using ctx = await setupMoveTest();

  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const exec = await readRejection(ctx.source.imps.openExec('dev', { argv: ['true'], tty: false }));

  await ctx.sourceApp.client.moves.abort({ name: 'dev' });
  await ctx.runMove();

  const calls = await ctx.targetApp.client.audit.calls({});

  const steps = calls.filter((call) => call.procedure.startsWith('move.'));

  expect(exec).toMatchObject({ code: 'MOVING' });
  expect(steps.map((call) => call.procedure)).toContain('move.commit');
  expect(steps.every((call) => call.imp === 'dev' && call.actor === 'tailnet')).toBe(true);
});
