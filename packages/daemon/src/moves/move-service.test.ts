import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { MoveStatus } from '@imp/api';
import { createImage } from '../db/images';
import { findImpByName } from '../db/imps';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';
import { buildImagePaths } from '../storage/data-layout';
import { createFakeZfs } from '../storage/zfs/fake-zfs';
import type { FakeZfs } from '../storage/zfs/fake-zfs';
import { createZfsBackend } from '../storage/zfs/zfs-backend';
import { MOVE_PART_HEADER, MOVE_PATHS } from './move-header';
import { ReceiptSchema, buildTicketHeader } from './move-tickets';

// the target's peer URL: a literal tailnet address, as a move needs
const TARGET_URL = 'http://100.100.0.2:7070';

// the source's address, as the target's socket sees it
const SOURCE_PEER = '100.100.0.1';

type FetchHook = (request: Request, forward: () => Promise<Response>) => Promise<Response>;

// Two impds in one process: `source` sends to `target` through `fetch`,
// which hands each request to the target's move routes as from the tailnet.
async function setupMoveTest(hook?: FetchHook, options: { readonly hasImage?: boolean } = {}) {
  const source = await setupImpTest();
  const target = await setupImpTest({ env: { IMP_PEER_URL: TARGET_URL } });

  const targetApp = buildTestApp(target, target);
  const sendToTarget = (request: Request) => targetApp.moves.handle(request, SOURCE_PEER);

  const sourceApp = buildTestApp(source, source, undefined, {}, null, {
    fetch: (request) =>
      hook === undefined ? sendToTarget(request) : hook(request, () => sendToTarget(request)),
  });

  const hosts = options.hasImage === false ? [source] : [source, target];

  for (const host of hosts) {
    await host.createTestImage('ubuntu');

    writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');
  }

  const created = await sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await sourceApp.client.imps.stop({ name: 'dev' });

  const disk = source.storage.resolveImpPaths(created.id).disk;

  writeFileSync(disk, 'hello');

  await sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  writeFileSync(disk, 'world');

  // runs a whole move, as `imp move` does, and waits for it to end
  const runMove = async (): Promise<MoveStatus> => {
    const plan = await sourceApp.client.moves.prepare({ name: 'dev' });
    const ticket = await targetApp.client.moves.receive({ name: 'dev', bytes: plan.bytes });

    await sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

    return waitForMove();
  };

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

  return {
    source,
    target,
    sourceApp,
    targetApp,
    impId: created.id,
    runMove,
    waitForMove,
    async [Symbol.asyncDispose]() {
      await source[Symbol.asyncDispose]();
      await target[Symbol.asyncDispose]();
    },
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

test('the image goes along when the target lacks it, and grants of known secrets carry', async () => {
  await using ctx = await setupMoveTest(undefined, { hasImage: false });

  await ctx.source.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.source.broker.addGrant('dev', 'gh');
  await ctx.target.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_other' });

  const status = await ctx.runMove();

  const image = buildImagePaths(ctx.target.dataDir, 'sha256:ubuntu');

  const grants = await ctx.target.broker.listGrants('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(readFileSync(image.rootfs, 'utf8').startsWith('rootfs')).toBe(true);
  expect(grants).toEqual(['gh']);
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

  const undone = await findImpByName(ctx.source.db, 'dev');

  await ctx.runMove();
  await ctx.sourceApp.moves.recover();

  for (
    let tries = 0;
    tries < 500 && (await findImpByName(ctx.source.db, 'dev')) !== undefined;
    tries += 1
  ) {
    await Bun.sleep(10);
  }

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

// an impd on a fake ZFS pool, with the image built there
async function setupZfsHost(env: Readonly<Record<string, string>> = {}) {
  const pool: { zfs: FakeZfs | null } = { zfs: null };

  const host = await setupImpTest({
    env,
    createStorage: (dataDir) => {
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
    },
  });

  await host.storage.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  // the fake pool keeps no files: the image is a dataset only
  await host.storage.createImage('sha256:ubuntu', () => Promise.resolve());

  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').rootfs, 'rootfs');
  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');

  await createImage(host.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  if (pool.zfs === null) {
    throw new Error('no pool');
  }

  return { host, zfs: pool.zfs, [Symbol.asyncDispose]: () => host[Symbol.asyncDispose]() };
}

test('between two ZFS hosts the disk and its checkpoints go as ZFS streams', async () => {
  await using source = await setupZfsHost();
  await using target = await setupZfsHost({ IMP_PEER_URL: TARGET_URL });

  const targetApp = buildTestApp(target.host, target.host);

  const sourceApp = buildTestApp(source.host, source.host, undefined, {}, null, {
    fetch: (request) => targetApp.moves.handle(request, SOURCE_PEER),
  });

  await sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const plan = await sourceApp.client.moves.prepare({
    name: 'dev',
    stop: true,
    targetStorage: 'zfs',
  });

  const ticket = await targetApp.client.moves.receive({ name: 'dev', bytes: plan.bytes });

  await sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  for (let tries = 0; tries < 500; tries += 1) {
    const status = await sourceApp.client.moves.status({ name: 'dev' });

    if (status.isDone || status.error !== null) {
      expect(status.error).toBeNull();
      break;
    }

    await Bun.sleep(10);
  }

  const checkpoints = await targetApp.client.checkpoints.list({ name: 'dev' });

  const received = target.zfs.commands.filter((command) => command.startsWith('zfs recv'));

  const moved = await targetApp.client.imps.get({ name: 'dev' });
  const left = await findImpByName(source.host.db, 'dev');

  expect(checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['one']);
  expect(received).toHaveLength(2);

  expect(target.zfs.listSnapshots()).toContain(
    `${ZFS_ROOT}/disks/${moved.id}@${checkpoints[0]?.id ?? ''}`,
  );

  expect(left).toBeUndefined();
});

test('an XFS host moves an imp to a ZFS host as files, checkpoints as snapshots', async () => {
  await using source = await setupImpTest();
  await using target = await setupZfsHost({ IMP_PEER_URL: TARGET_URL });

  const targetApp = buildTestApp(target.host, target.host);

  const sourceApp = buildTestApp(source, source, undefined, {}, null, {
    fetch: (request) => targetApp.moves.handle(request, SOURCE_PEER),
  });

  await source.createTestImage('ubuntu');

  writeFileSync(buildImagePaths(source.dataDir, 'sha256:ubuntu').config, '{}');

  const created = await sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(source.storage.resolveImpPaths(created.id).disk, 'hello');

  await sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const plan = await sourceApp.client.moves.prepare({ name: 'dev', targetStorage: 'zfs' });
  const ticket = await targetApp.client.moves.receive({ name: 'dev', bytes: plan.bytes });

  await sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  for (let tries = 0; tries < 500; tries += 1) {
    const status = await sourceApp.client.moves.status({ name: 'dev' });

    if (status.isDone || status.error !== null) {
      expect(status.error).toBeNull();
      break;
    }

    await Bun.sleep(10);
  }

  const checkpoints = await targetApp.client.checkpoints.list({ name: 'dev' });

  const disk = readFileSync(target.host.storage.resolveImpPaths(created.id).disk, 'utf8');

  expect(disk.startsWith('hello')).toBe(true);

  expect(target.zfs.listSnapshots()).toContain(
    `${ZFS_ROOT}/disks/${created.id}@${checkpoints[0]?.id ?? ''}`,
  );
});
