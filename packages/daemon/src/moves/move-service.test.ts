import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { findImageByName } from '../db/images';
import { findImpByName, updateImpExposure, updateImpMove } from '../db/imps';
import { TEST_TOKEN, buildTestApp } from '../imps/test-imps';
import { buildMockMoveTicketRow } from '../test-utils/build-mock-move-ticket-row';
import {
  buildJsonMoveFrame,
  buildStubMoveStreamRewrite,
} from '../test-utils/build-stub-move-stream-rewrite';
import { buildStubOlderMoveTarget } from '../test-utils/build-stub-older-move-target';
import { buildStubZfsStorage } from '../test-utils/build-stub-zfs-storage';
import { FileEndSchema, MOVE_FRAMES, MoveFileSchema, readJsonPayload } from './move-frames';
import {
  MOVE_FINISH_HEADER,
  MOVE_PART_HEADER,
  MOVE_PATHS,
  MoveHeaderSchema,
  MoveOfferReplySchema,
} from './move-header';
import {
  ReceiptSchema,
  buildReceipt,
  buildTicketHeader,
  readReceipt,
  readTicketHeader,
} from './move-tickets';
import {
  SOURCE_PEER,
  TARGET_URL,
  createUbuntuImage,
  createZfsUbuntuImage,
  setupMoveHosts,
} from './test-moves';
import type { MoveHostsOptions } from './test-moves';

// two impds, the source's move routes reaching the target's in process
function setupTest(config: Readonly<MoveHostsOptions> = {}) {
  return setupMoveHosts(config);
}

test('it moves a stopped imp with its id, its checkpoint and its disk', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'hello');

  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'world');

  const status = await ctx.runMove('dev');
  const moved = await ctx.targetApp.client.imps.get({ name: 'dev' });
  const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });
  const left = await findImpByName(ctx.source.db, 'dev');

  invariant(checkpoints[0]);

  const impDir = join(ctx.target.dataDir, 'imps', created.id);
  const disk = readFileSync(join(impDir, 'disk.ext4'), 'utf8');

  const checkpointDisk = readFileSync(
    join(impDir, 'checkpoints', checkpoints[0].id, 'disk.ext4'),
    'utf8',
  );

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved).toMatchObject({ id: created.id, state: 'stopped' });
  expect(moved.move).toBeUndefined();
  expect(checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['one']);
  expect(disk).toStartWith('world');
  expect(checkpointDisk).toStartWith('hello');
  expect(left).toBeUndefined();
  expect(ctx.commits).toStrictEqual(['dev']);
});

test('it refuses a start of a marked imp with MOVING and a retry after 30 s', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.sourceApp.client.imps.start({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
    status: 409,
    data: { retryAfterS: 30 },
  });
});

test('it refuses a destroy of a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.sourceApp.client.imps.destroy({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
    status: 409,
    data: { retryAfterS: 30 },
  });
});

test('it refuses a disk resize of a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(
    ctx.sourceApp.client.imps.resizeDisk({ name: 'dev', diskMib: 2048 }),
  ).rejects.toMatchObject({ code: 'MOVING', status: 409, data: { retryAfterS: 30 } });
});

test('it refuses a checkpoint of a marked imp with MOVING', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.sourceApp.client.checkpoints.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
    status: 409,
    data: { retryAfterS: 30 },
  });
});

test('it answers a raw start of a marked imp with 409 and a Retry-After header', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const raw = await ctx.sourceApp.app.handle(
    new Request('http://impd.test/rpc/imps/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'dev' } }),
    }),
  );

  expect(raw.status).toBe(409);
  expect(raw.headers.get('retry-after')).toBe('30');
});

test('it lists a prepared imp as sending', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const listed = await ctx.sourceApp.client.imps.get({ name: 'dev' });

  expect(listed.move).toBe('sending');
});

test('it lets an imp start again once an abort before the stream undoes its mark', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });
  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const started = await ctx.sourceApp.client.imps.start({ name: 'dev' });

  expect(started.state).toBe('running');

  // nothing reached the target, so it counted nothing
  expect(ctx.commits).toStrictEqual([]);
});

test('it refuses to move a public imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await updateImpExposure(ctx.source.db, created.id, { auth: 'none', user: null, hash: null });

  expect(ctx.sourceApp.client.moves.prepare({ name: 'dev' })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
});

test('it refuses an unexpose of a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.sourceApp.client.imps.unexpose({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
  });
});

test('it writes no exposure change to a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const written = await updateImpExposure(ctx.source.db, created.id, {
    auth: 'none',
    user: null,
    hash: null,
  });

  expect(written).toBeUndefined();
});

test('it refuses to move a running imp without stop', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  expect(ctx.sourceApp.client.moves.prepare({ name: 'dev' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
});

test('it stops a running imp that a prepare with stop marks', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev', stop: true });

  const imp = await ctx.sourceApp.client.imps.get({ name: 'dev' });

  expect(imp).toMatchObject({ state: 'stopped', move: 'sending' });
});

test('it leaves the source unmarked and the target empty when the receipt is not signed with the ticket', async () => {
  const ctx = await setupTest({
    hook: async (request, forward) => {
      const response = await forward();

      if (request.headers.get(MOVE_FINISH_HEADER) !== '1') {
        return response;
      }

      const answer: unknown = await response.json();

      const receipt = ReceiptSchema.parse(answer);

      return Response.json({ ...receipt, mac: '00'.repeat(32) });
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const source = await findImpByName(ctx.source.db, 'dev');
  const target = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('the receipt is not signed with this ticket');
  expect(source?.moveState).toBeNull();
  expect(target).toBeUndefined();
});

test('it leaves the source unmarked when a signed receipt does not match what was sent', async () => {
  const ctx = await setupTest({
    hook: async (request, forward) => {
      const response = await forward();

      const secret = readTicketHeader(request)?.secret;

      if (request.headers.get(MOVE_FINISH_HEADER) !== '1' || secret === undefined) {
        return response;
      }

      const answer: unknown = await response.json();

      const body = readReceipt(ReceiptSchema.parse(answer), secret);

      invariant(body);

      const files = body.files.map((file) => ({ ...file, sha256: '0'.repeat(64) }));

      return Response.json(buildReceipt({ ...body, files }, secret));
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const source = await findImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('the receipt does not match what was sent');
  expect(source?.moveState).toBeNull();
});

test('it ends a send to a target that is gone with the mark on, and says the abort went unconfirmed', async () => {
  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.receive) || request.url.endsWith(MOVE_PATHS.abort)) {
        return Promise.reject(new TypeError('Unable to connect'));
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const source = await findImpByName(ctx.source.db, 'dev');

  expect(status.state).toBe('sending');
  expect(status.error).toContain('the target did not confirm the abort');
  expect(source?.moveState).toBe('sending');
});

test('it reports no error for a failed send while its abort still goes', async () => {
  const abortReached = Promise.withResolvers<undefined>();
  const abortRelease = Promise.withResolvers<undefined>();
  const sendEnded = { wait: (): Promise<unknown> => Promise.resolve() };

  // the held abort, and with it the send, ends before the hosts go
  onTestFinished(() => {
    abortRelease.resolve(undefined);

    return sendEnded.wait();
  });

  const ctx = await setupTest({
    hook: async (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.abort)) {
        abortReached.resolve(undefined);

        await abortRelease.promise;

        throw new TypeError('Unable to connect');
      }

      if (request.url.endsWith(MOVE_PATHS.receive)) {
        throw new TypeError('Unable to connect');
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 * 1024 });

  await ctx.sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  sendEnded.wait = () => ctx.waitForMove('dev');

  await abortReached.promise;

  const during = await ctx.sourceApp.client.moves.status({ name: 'dev' });

  expect(during).toMatchObject({ isDone: false, error: null });
});

test('it keeps both copies marked when the commit is lost after the receipt', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('the network dropped the commit'));
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const source = await findImpByName(ctx.source.db, 'dev');
  const target = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('dropped the commit');
  expect(source?.moveState).toBe('moved');
  expect(target?.moveState).toBe('receiving');
});

test('it refuses a start on the target of a copy whose commit was lost', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('the network dropped the commit'));
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  expect(ctx.targetApp.client.imps.start({ name: 'dev' })).rejects.toMatchObject({
    code: 'MOVING',
  });
});

test('it commits on resume after a lost commit, and the source copy goes', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('the network dropped the commit'));
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const failed = await ctx.runMove('dev');
  const resumed = await ctx.sourceApp.client.moves.resume({ name: 'dev' });
  const source = await findImpByName(ctx.source.db, 'dev');
  const target = await findImpByName(ctx.target.db, 'dev');

  expect(failed.error).toContain('dropped the commit');
  expect(resumed.isDone).toBe(true);
  expect(source).toBeUndefined();
  expect(target?.moveState).toBeNull();
});

// #167: main counts the received disk on this hook, so a repeat must not
// fire it again
test('it fires onCommitted once when a commit whose answer was lost resumes', async () => {
  const lost = { answers: 1 };

  const ctx = await setupTest({
    hook: async (request, forward) => {
      const response = await forward();

      if (request.url.endsWith(MOVE_PATHS.commit) && lost.answers > 0) {
        lost.answers -= 1;
        throw new Error('the network dropped the answer');
      }

      return response;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const failed = await ctx.runMove('dev');
  const resumed = await ctx.sourceApp.client.moves.resume({ name: 'dev' });

  expect(failed.error).toContain('dropped the answer');
  expect(resumed.isDone).toBe(true);
  expect(ctx.commits).toStrictEqual(['dev']);
});

test('it destroys the source copy on an abort after the target committed', async () => {
  const lost = { answers: 1 };

  const ctx = await setupTest({
    hook: async (request, forward) => {
      const response = await forward();

      // the commit lands, but its answer never reaches the source
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.answers > 0) {
        lost.answers -= 1;
        throw new Error('the answer was lost');
      }

      return response;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const failed = await ctx.runMove('dev');
  const aborted = await ctx.sourceApp.client.moves.abort({ name: 'dev' });
  const source = await findImpByName(ctx.source.db, 'dev');
  const target = await ctx.targetApp.client.imps.get({ name: 'dev' });

  expect(failed.error).toContain('the answer was lost');
  expect(aborted.isDone).toBe(true);
  expect(source).toBeUndefined();
  expect(target.move).toBeUndefined();

  // the target's one commit counted the disk; the abort counts nothing more
  expect(ctx.commits).toStrictEqual(['dev']);
});

test('it refuses a ticket in the URL in place of the header', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}?ticket=${ticket.ticket}`, {
      method: 'POST',
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(401);

  expect(body).toStrictEqual({
    error: 'no move ticket in the Authorization header',
  });
});

test('it refuses a ticket the target never issued', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const forged = `${ticket.ticket.slice(0, ticket.ticket.indexOf('.'))}.not-the-secret`;

  const response = await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
      method: 'POST',
      headers: buildTicketHeader(forged),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(401);
  expect(body).toStrictEqual({ error: 'unknown move ticket' });
});

test('it refuses a stream from off the tailnet', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    '192.168.1.5',
  );

  expect(response.status).toBe(403);
});

test('it takes the first part of a stream from the tailnet', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  expect(response.status).toBe(202);
});

test('it refuses a second stream on a ticket', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const second = await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await second.json();

  expect(second.status).toBe(409);

  expect(body).toStrictEqual({
    error: 'the move ticket was used for a stream already',
  });
});

test('it refuses a part that comes before the first', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
      method: 'POST',
      headers: { ...buildTicketHeader(ticket.ticket), [MOVE_PART_HEADER]: '1' },
      body: new Uint8Array([9, 0, 0, 0, 0]),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(409);
  expect(body).toStrictEqual({ error: 'part 1 is out of order' });
});

test('it refuses a finish for a ticket with no stream', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
      method: 'POST',
      headers: { ...buildTicketHeader(ticket.ticket), [MOVE_FINISH_HEADER]: '1' },
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(409);
  expect(body).toStrictEqual({ error: 'no stream to finish for this ticket' });
});

test('it refuses a commit for a ticket with no receipt', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1024 });

  const response = await ctx.targetApp.moves.handle(
    new Request(`${TARGET_URL}${MOVE_PATHS.commit}`, {
      method: 'POST',
      headers: buildTicketHeader(ticket.ticket),
    }),
    SOURCE_PEER,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(409);

  expect(body).toStrictEqual({
    error: 'nothing to commit: no receipt for this ticket',
  });
});

test('it refuses a ticket for a name the target has', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.target);

  await ctx.targetApp.client.imps.create({ name: 'taken', image: 'ubuntu' });

  expect(ctx.targetApp.client.moves.receive({ name: 'taken', bytes: 1 })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('it refuses a stream that starts past its ticket window', async () => {
  const ctx = await setupTest();
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

  const body: unknown = await late.json();

  expect(late.status).toBe(410);

  expect(body).toStrictEqual({
    error: 'the move ticket expired before its stream started',
  });
});

test('it cuts off a stream longer than its ticket and leaves nothing on the target', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 3 });

  await ctx.sourceApp.client.moves.send({ name: 'dev', to: ticket.peerUrl, ticket: ticket.ticket });

  const status = await ctx.waitForMove('dev');
  const target = await findImpByName(ctx.target.db, 'dev');
  const source = await findImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('the stream is longer than its ticket allows');
  expect(target).toBeUndefined();
  expect(source?.moveState).toBeNull();
});

test('it refuses a peer URL off the tailnet before any byte goes', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(
    ctx.sourceApp.client.moves.send({ name: 'dev', to: 'http://192.168.1.5:7070', ticket: 'a.b' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses a peer URL that names a host before any byte goes', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(
    ctx.sourceApp.client.moves.send({ name: 'dev', to: 'http://imp-b:7070', ticket: 'a.b' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it files the image a target lacks under the digest of what arrived', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const image = await findImageByName(ctx.target.db, 'ubuntu');

  invariant(image);

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(image.digest).toStartWith('sha256:');

  // filed under what arrived, never the source's claim
  expect(image.digest).not.toBe('sha256:ubuntu');

  const hex = image.digest.slice('sha256:'.length);
  const rootfs = readFileSync(join(ctx.target.dataDir, 'images', hex, 'rootfs.ext4'));

  expect(rootfs.toString()).toStartWith('rootfs');
});

test('it carries only the grants of secrets the target has', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.source.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.source.broker.addSecret({ name: 'npm', kind: 'npm', value: 'npm_real' });
  await ctx.source.broker.addGrant('dev', 'gh');
  await ctx.source.broker.addGrant('dev', 'npm');
  await ctx.target.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_other' });

  const status = await ctx.runMove('dev');
  const grants = await ctx.target.broker.listGrants('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(grants).toStrictEqual(['gh']);
});

test('it keeps the owed identity reset of a template copy, and its template stays a template', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await ctx.source.db
    .updateTable('images')
    .set({ source: 'imp', source_imp: 'golden' })
    .where('name', '=', 'ubuntu')
    .execute();

  await ctx.source.db
    .updateTable('imps')
    .set({ identity_reset_pending: 1 })
    .where('id', '=', created.id)
    .execute();

  const status = await ctx.runMove('dev');
  const image = await findImageByName(ctx.target.db, 'ubuntu');
  const moved = await findImpByName(ctx.target.db, 'dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(image).toMatchObject({ source: 'imp', sourceImp: 'golden' });
  expect(moved?.isIdentityResetPending).toBe(true);
});

test('it keeps the max memory of an elastic imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

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

test('it refuses to move an elastic imp to a target that would drop its max memory', async () => {
  const ctx = await setupTest({ hook: buildStubOlderMoveTarget('keepsMaxMemory') });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', created.id)
    .execute();

  const status = await ctx.runMove('dev');
  const landed = await findImpByName(ctx.target.db, 'dev');
  const source = await findImpByName(ctx.source.db, 'dev');

  // nothing went: the source keeps the imp, unmarked, and the target has none
  expect(status.error).toContain('predates elastic memory');
  expect(status.sentBytes).toBe(0);
  expect(source).toMatchObject({ state: 'stopped', moveState: null, maxMemoryMib: 1024 });
  expect(landed).toBeUndefined();
});

test('it starts a running elastic imp again that --stop halted when the target refuses its max memory', async () => {
  const ctx = await setupTest({ hook: buildStubOlderMoveTarget('keepsMaxMemory') });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.source.db
    .updateTable('imps')
    .set({ memory_mib: 256, max_memory_mib: 1024 })
    .where('id', '=', created.id)
    .execute();

  const status = await ctx.runMove('dev', true);
  const source = await findImpByName(ctx.source.db, 'dev');
  const landed = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('predates elastic memory');
  expect(source).toMatchObject({ state: 'running', moveState: null });
  expect(landed).toBeUndefined();
});

test('it keeps every file the send reads through a GC while the stream goes', async () => {
  const runs: (readonly unknown[])[] = [];

  const ctx = await setupTest({
    hook: async (request, forward, hosts) => {
      if (
        request.url.endsWith(MOVE_PATHS.receive) &&
        request.headers.get(MOVE_PART_HEADER) === '0'
      ) {
        const result = await hosts.sourceApp.client.system.gc({});

        runs.push(result.dropped);
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(runs).toStrictEqual([[]]);
});

test('it refuses a grant change to a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.source.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.source.broker.addGrant('dev', 'gh')).rejects.toMatchObject({ code: 'MOVING' });
});

test('it refuses an egress policy change to a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.source.egress.setPolicy('dev', { mode: 'none', allow: [] })).rejects.toMatchObject({
    code: 'MOVING',
  });
});

test('it undoes on restart a send cut short', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });
  await ctx.sourceApp.moves.recover();

  // recovery runs in the background
  const undone = await waitFor(async () => {
    const imp = await findImpByName(ctx.source.db, 'dev');

    if (imp?.moveState !== null) {
      throw new Error('the mark is still on');
    }

    return imp;
  });

  expect(undone.moveState).toBeNull();
});

test('it finishes on restart a send the target has verified', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('impd stopped'));
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const failed = await ctx.runMove('dev');

  await ctx.sourceApp.moves.recover();

  // recovery runs in the background
  await waitFor(async () => {
    const imp = await findImpByName(ctx.source.db, 'dev');

    if (imp !== undefined) {
      throw new Error('the source copy is still here');
    }
  });

  const live = await ctx.targetApp.client.imps.get({ name: 'dev' });

  expect(failed.error).toContain('impd stopped');
  expect(live.move).toBeUndefined();
});

test('it removes on a target restart a stream cut short and tickets never used', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.target);

  const staged = await ctx.target.imps.createImp({
    name: 'half',
    image: 'ubuntu',
    moveState: 'receiving',
  });

  const now = ctx.target.now();

  await ctx.target.db
    .insertInto('move_tickets')
    .values(
      buildMockMoveTicketRow({
        name: 'half',
        imp_id: staged.id,
        issued_at: now,
        stream_by: now + 1000,
        stream_used_at: now,
      }),
    )
    .execute();

  await ctx.targetApp.client.moves.receive({ name: 'later', bytes: 1 });

  ctx.target.advance(11 * 60 * 1000);

  await ctx.targetApp.moves.recover();

  const rows = await ctx.target.db.selectFrom('move_tickets').select('id').execute();
  const gone = await findImpByName(ctx.target.db, 'half');

  expect(gone).toBeUndefined();
  expect(rows).toStrictEqual([]);
});

test('it counts a target that holds the imp unmarked as committed', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('the network dropped the commit'));
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  // as a crash between the mark and the ticket would have left it
  await updateImpMove(ctx.target.db, created.id, null);

  const aborted = await ctx.sourceApp.client.moves.abort({ name: 'dev' });
  const gone = await findImpByName(ctx.source.db, 'dev');

  expect(aborted.isDone).toBe(true);
  expect(gone).toBeUndefined();
});

test('it refuses a resume whose received copy is gone, and the source keeps its copy', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('the network dropped the commit'));
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');
  await ctx.target.imps.destroyImp('dev', { isMove: true });

  expect(ctx.sourceApp.client.moves.resume({ name: 'dev' })).rejects.toMatchObject({
    code: 'BAD_GATEWAY',
    message: 'commit: the target answered 409 nothing to commit: the received copy is gone',
  });

  const kept = await findImpByName(ctx.source.db, 'dev');

  expect(kept?.moveState).toBe('moved');
});

test('it refuses a resume past the commit window, and the source keeps its copy', async () => {
  const lost = { commits: 1 };

  const ctx = await setupTest({
    hook: (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;

        return Promise.reject(new Error('the network dropped the commit'));
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  ctx.target.advance(24 * 60 * 60 * 1000 + 60_000);

  expect(ctx.sourceApp.client.moves.resume({ name: 'dev' })).rejects.toMatchObject({
    code: 'BAD_GATEWAY',
    message: 'commit: the target answered 410 the commit window ended; reissue the ticket',
  });

  const kept = await findImpByName(ctx.source.db, 'dev');

  expect(kept?.moveState).toBe('moved');
});

test('it fails a send whose target answers the commit as not committed', async () => {
  const ctx = await setupTest({
    hook: (request, forward) =>
      request.url.endsWith(MOVE_PATHS.commit)
        ? Promise.resolve(Response.json({ isCommitted: false }))
        : forward(),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const source = await findImpByName(ctx.source.db, 'dev');

  expect(status.error).toContain('commit: the target did not commit');
  expect(source?.moveState).toBe('moved');
});

test('it moves the imp to the target when its commit lands before a racing abort', async () => {
  const lost = { commits: 1 };
  const committed = Promise.withResolvers<undefined>();

  const ctx = await setupTest({
    hook: async (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;
        throw new Error('the network dropped the commit');
      }

      // the abort reaches the target only once the resume's commit landed
      if (request.url.endsWith(MOVE_PATHS.abort)) {
        await committed.promise;
      }

      const response = await forward();

      if (request.url.endsWith(MOVE_PATHS.commit)) {
        committed.resolve(undefined);
      }

      return response;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  const settled = await Promise.allSettled([
    ctx.sourceApp.client.moves.abort({ name: 'dev' }),
    ctx.sourceApp.client.moves.resume({ name: 'dev' }),
  ]);

  const source = await findImpByName(ctx.source.db, 'dev');
  const target = await findImpByName(ctx.target.db, 'dev');

  expect(settled.map((result) => result.status)).toStrictEqual(['fulfilled', 'fulfilled']);
  expect(source).toBeUndefined();
  expect(target?.moveState).toBeNull();
});

test('it keeps the imp on the source when a racing abort reaches the target before the commit', async () => {
  const lost = { commits: 1 };
  const aborted = Promise.withResolvers<undefined>();

  const ctx = await setupTest({
    hook: async (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.commit) && lost.commits > 0) {
        lost.commits -= 1;
        throw new Error('the network dropped the commit');
      }

      // the resume's commit reaches the target only once the abort is through
      if (request.url.endsWith(MOVE_PATHS.commit)) {
        await aborted.promise;
      }

      const response = await forward();

      if (request.url.endsWith(MOVE_PATHS.abort)) {
        aborted.resolve(undefined);
      }

      return response;
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  const settled = await Promise.allSettled([
    ctx.sourceApp.client.moves.resume({ name: 'dev' }),
    ctx.sourceApp.client.moves.abort({ name: 'dev' }),
  ]);

  const source = await findImpByName(ctx.source.db, 'dev');
  const target = await findImpByName(ctx.target.db, 'dev');

  expect(settled.map((result) => result.status)).toStrictEqual(['rejected', 'fulfilled']);
  expect(source?.moveState).toBeNull();
  expect(target).toBeUndefined();
});

test('it takes a receive with a token that manages the whole host', async () => {
  const ctx = await setupTest();
  const made = await ctx.targetApp.client.tokens.create({ name: 'mover', scope: 'manage' });

  const app = buildTestApp(ctx.target, ctx.target, made.secret);

  const ticket = await app.client.moves.receive({ name: 'dev', bytes: 1 });

  expect(ticket.peerUrl).toBe(TARGET_URL);
});

test('it refuses a receive with a token scoped to imps', async () => {
  const ctx = await setupTest();

  const made = await ctx.targetApp.client.tokens.create({
    name: 'mover',
    scope: 'manage',
    imps: ['dev'],
  });

  const app = buildTestApp(ctx.target, ctx.target, made.secret);

  expect(app.client.moves.receive({ name: 'dev', bytes: 1 })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it refuses a reissue with a token scoped to imps', async () => {
  const ctx = await setupTest();

  const made = await ctx.targetApp.client.tokens.create({
    name: 'mover',
    scope: 'manage',
    imps: ['dev'],
  });

  const app = buildTestApp(ctx.target, ctx.target, made.secret);

  expect(app.client.moves.reissue({ name: 'dev' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses an exec in a marked imp', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.moves.prepare({ name: 'dev' });

  expect(ctx.source.imps.openExec('dev', { argv: ['true'], tty: false })).rejects.toMatchObject({
    code: 'MOVING',
  });
});

test('it writes each /move step of the target to its audit log as the tailnet', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.runMove('dev');

  const calls = await ctx.targetApp.client.audit.calls({});

  const steps = calls.filter((call) => call.procedure.startsWith('move.'));

  expect(steps.map((call) => call.procedure)).toContain('move.commit');
  expect(steps).toIncludeAllPartialMembers([{ imp: 'dev', actor: 'tailnet' }]);
  expect(steps.filter((call) => call.imp !== 'dev' || call.actor !== 'tailnet')).toStrictEqual([]);
});

test('it goes on with a stream longer than 10 minutes while its parts keep coming', async () => {
  const ctx = await setupTest({
    partBytes: 4096,
    hook: (request, forward, hosts) => {
      // 50 s between parts, on the target's clock
      if (request.headers.has(MOVE_PART_HEADER)) {
        hosts.target.advance(50_000);
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'x'.repeat(64 * 1024));

  const status = await ctx.runMove('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
});

test('it ends the stream when a part comes more than 60 s after the last', async () => {
  const ctx = await setupTest({
    partBytes: 4096,
    hook: (request, forward, hosts) => {
      if (request.headers.get(MOVE_PART_HEADER) === '1') {
        hosts.target.advance(61_000);
      }

      return forward();
    },
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'x'.repeat(64 * 1024));

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('the next part of the move stream came too late');
  expect(staged).toBeUndefined();
});

test('it refuses a stream that does not start with its header', async () => {
  const ctx = await setupTest({ hook: buildStubMoveStreamRewrite((frames) => frames.slice(1)) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('the stream does not start with its header');
  expect(staged).toBeUndefined();
});

test('it refuses a stream whose header names another imp than its ticket', async () => {
  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, { ...header, imp: { ...header.imp, name: 'other' } });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('the ticket is for dev, not other');
});

test('it refuses a stream for an imp id the target has', async () => {
  const taken = { id: '' };

  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, { ...header, imp: { ...header.imp, id: taken.id } });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const other = await ctx.targetApp.client.imps.create({ name: 'other', image: 'ubuntu' });

  taken.id = other.id;

  const status = await ctx.runMove('dev');

  expect(status.error).toContain(`this host has an imp with id ${other.id}`);
});

test('it refuses a stream that leaves out an image the target lacks', async () => {
  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, {
          ...header,
          image: { ...header.image, isIncluded: false },
        });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('this host has no image sha256:ubuntu');
});

test('it refuses a stream that ends after its header', async () => {
  const ctx = await setupTest({ hook: buildStubMoveStreamRewrite((frames) => frames.slice(0, 1)) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('the stream has no checkpoint file');
});

test('it refuses a stream that sends one file where another goes', async () => {
  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.file
          ? buildJsonMoveFrame(frame.type, {
              ...MoveFileSchema.parse(readJsonPayload(frame.payload)),
              kind: 'disk',
            })
          : frame,
      ),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('the stream sent disk where checkpoint goes');
});

test('it refuses a stream that ends inside a file', async () => {
  const ctx = await setupTest({ hook: buildStubMoveStreamRewrite((frames) => frames.slice(0, 2)) });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('the stream ended inside a file');
});

test('it refuses a file whose sha256 does not match its data', async () => {
  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.fileEnd
          ? buildJsonMoveFrame(frame.type, {
              ...FileEndSchema.parse(readJsonPayload(frame.payload)),
              sha256: '0'.repeat(64),
            })
          : frame,
      ),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('checkpoint: the sha256 does not match the data');
});

test('it refuses a frame inside a file that is neither data nor its end', async () => {
  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) => [
      ...frames.slice(0, 2),
      buildJsonMoveFrame(MOVE_FRAMES.end, {}),
    ]),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain(`an unexpected frame ${String(MOVE_FRAMES.end)} in a file`);
});

test('it refuses a data frame past the end of its file', async () => {
  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.file
          ? buildJsonMoveFrame(frame.type, {
              ...MoveFileSchema.parse(readJsonPayload(frame.payload)),
              sizeBytes: 0,
            })
          : frame,
      ),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('a DATA frame past the end of its file');
});

test('it refuses a stream that does not end with END', async () => {
  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.filter((frame) => frame.type !== MOVE_FRAMES.end),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await ctx.runMove('dev');
  const staged = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('the stream does not end with END');
  expect(staged).toBeUndefined();
});

test('it refuses ZFS streams that do not name each checkpoint once', async () => {
  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, { ...header, streams: [] });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('the streams do not name each checkpoint once');
});

test('it refuses ZFS streams on a target that is not on ZFS', async () => {
  const ctx = await setupTest({
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.header) {
          return frame;
        }

        const header = MoveHeaderSchema.parse(readJsonPayload(frame.payload));

        return buildJsonMoveFrame(frame.type, {
          ...header,
          streams: [
            { checkpoint: 0, dataset: 0, base: null },
            { checkpoint: null, dataset: 0, base: 0 },
          ],
        });
      }),
    ),
  });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.imps.stop({ name: 'dev' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');

  expect(status.error).toContain('this host is not on ZFS: it takes a move as files only');
});

test('it sends the disk and its checkpoints between two ZFS hosts as ZFS streams', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev', true);
  const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });
  const moved = await ctx.targetApp.client.imps.get({ name: 'dev' });
  const left = await findImpByName(ctx.source.db, 'dev');

  const received = targetZfs
    .readPool()
    .commands.filter((command) => command.startsWith('zfs recv'));

  invariant(checkpoints[0]);

  expect(status.error).toBeNull();
  expect(checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['one']);
  expect(received).toHaveLength(2);

  expect(targetZfs.readPool().listSnapshots()).toContain(
    `tank/imp/disks/${moved.id}@${checkpoints[0].id}`,
  );

  expect(left).toBeUndefined();
});

test.each([
  ['source', false],
  ['source', true],
  ['target', false],
  ['target', true],
] as const)(
  'it finds nothing for a GC on the %s to drop or keep after a ZFS move (orphans: %p)',
  async (host, orphans) => {
    const sourceZfs = buildStubZfsStorage('tank/imp');
    const targetZfs = buildStubZfsStorage('tank/imp');

    const ctx = await setupTest({
      source: { createStorage: sourceZfs.createStorage },
      target: { createStorage: targetZfs.createStorage },
    });

    await createZfsUbuntuImage(ctx.source);
    await createZfsUbuntuImage(ctx.target);

    await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
    await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });
    await ctx.runMove('dev', true);

    const sweep = await (host === 'source' ? ctx.sourceApp : ctx.targetApp).client.system.gc({
      orphans,
    });

    expect(sweep.dropped).toStrictEqual([]);
    expect(sweep.kept).toStrictEqual([]);
  },
);

test('it leaves no move snapshot and no staging dataset in either pool after a ZFS move', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev', true);

  const snapshots = [sourceZfs, targetZfs].flatMap((zfs) => zfs.readPool().listSnapshots());
  const datasets = [sourceZfs, targetZfs].flatMap((zfs) => zfs.readPool().listDatasets());

  expect(status.error).toBeNull();
  expect(snapshots).not.toContainEqual(expect.stringContaining('@mv-'));
  expect(datasets).not.toContainEqual(expect.stringContaining('/staging/'));
});

test('it never commits a ZFS stream whose sum does not match', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.fileEnd
          ? buildJsonMoveFrame(frame.type, {
              ...FileEndSchema.parse(readJsonPayload(frame.payload)),
              sha256: '0'.repeat(64),
            })
          : frame,
      ),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev', true);

  const pool = targetZfs.readPool();
  const received = pool.commands.filter((command) => command.startsWith('zfs recv'));

  // nothing to clean up: `zfs recv` never saw the stream's end
  const cleaned = pool.commands.filter(
    (command) => command.includes('/staging/mvin-') && !command.startsWith('zfs recv'),
  );

  const absent = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('ZFS stream 0: the sha256 does not match');
  expect(received).toHaveLength(1);
  expect(pool.listDatasets()).not.toContainEqual(expect.stringContaining('/staging/'));
  expect(cleaned).toStrictEqual([]);
  expect(absent).toBeUndefined();
});

test('it moves an imp between ZFS hosts again after a stream whose sum did not match', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');
  const corrupt = { remaining: 1 };

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.fileEnd || corrupt.remaining === 0) {
          return frame;
        }

        corrupt.remaining -= 1;

        return buildJsonMoveFrame(frame.type, { sha256: '0'.repeat(64) });
      }),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const failed = await ctx.runMove('dev', true);

  await ctx.sourceApp.client.moves.abort({ name: 'dev' });

  const retried = await ctx.runMove('dev', true);

  expect(failed.error).toContain('ZFS stream 0: the sha256 does not match');
  expect(retried).toMatchObject({ isDone: true, error: null });
});

test('it refuses a ZFS move whose stream leaves out a ZFS stream', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.filter((frame) => frame.type !== MOVE_FRAMES.file),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const status = await ctx.runMove('dev', true);

  expect(status.error).toContain('the stream has no ZFS stream 0');
});

test('it refuses a ZFS stream that ends before its sum', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) =>
        frame.type === MOVE_FRAMES.fileEnd ? buildJsonMoveFrame(MOVE_FRAMES.end, {}) : frame,
      ),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const status = await ctx.runMove('dev', true);

  expect(status.error).toContain('ZFS stream 0 ended early');
});

test('it refuses a ZFS stream whose data frames come out of order', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: buildStubMoveStreamRewrite((frames) =>
      frames.map((frame) => {
        if (frame.type !== MOVE_FRAMES.data) {
          return frame;
        }

        const payload = new Uint8Array(frame.payload);

        // the 8-byte big-endian offset that opens a DATA payload
        new DataView(payload.buffer).setBigUint64(0, 1n);

        return { type: frame.type, payload };
      }),
    ),
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const status = await ctx.runMove('dev', true);

  expect(status.error).toContain('ZFS stream 0: a DATA frame out of order');
});

test('it fails a ZFS move to a target that left ZFS since the prepare', async () => {
  const sourceZfs = buildStubZfsStorage('tank/imp');
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({
    source: { createStorage: sourceZfs.createStorage },
    target: { createStorage: targetZfs.createStorage },
    hook: async (request, forward) => {
      const response = await forward();

      if (!request.url.endsWith(MOVE_PATHS.offer)) {
        return response;
      }

      const answer: unknown = await response.json();

      const reply = MoveOfferReplySchema.parse(answer);

      return Response.json({ ...reply, storage: 'xfs' });
    },
  });

  await createZfsUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const status = await ctx.runMove('dev', true);

  expect(status.error).toContain('the target is not on ZFS any more; prepare the move again');
});

test('it moves an imp from an XFS host to a ZFS host as files, its checkpoints as snapshots', async () => {
  const targetZfs = buildStubZfsStorage('tank/imp');

  const ctx = await setupTest({ target: { createStorage: targetZfs.createStorage } });

  await createUbuntuImage(ctx.source);
  await createZfsUbuntuImage(ctx.target);

  const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.stop({ name: 'dev' });

  writeFileSync(ctx.source.storage.resolveImpPaths(created.id).disk, 'hello');

  await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

  const status = await ctx.runMove('dev');
  const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });

  invariant(checkpoints[0]);

  expect(status.error).toBeNull();

  expect(readFileSync(ctx.target.storage.resolveImpPaths(created.id).disk, 'utf8')).toStartWith(
    'hello',
  );

  expect(targetZfs.readPool().listSnapshots()).toContain(
    `tank/imp/disks/${created.id}@${checkpoints[0].id}`,
  );
});
