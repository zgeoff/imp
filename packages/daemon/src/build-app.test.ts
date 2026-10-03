import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { listApiCalls } from './db/api-audit';
import { findImpByName } from './db/imps';
import { TEST_SYSTEM_FILES, TEST_TOKEN, buildTestApp, setupImpTest } from './imps/test-imps';
import { tryExecSocket, tryTunnelSocket } from './test-sockets';

async function setupTest(token: string, env: Readonly<Record<string, string>> = {}) {
  const harness = await setupImpTest({ env });

  return { ...harness, ...buildTestApp(harness, harness, token) };
}

test('it serves system.info from config and the database', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const { storage, ...info } = await ctx.client.system.info();

  // the test data dir's own filesystem
  expect(storage.backend).toBe('xfs');
  expect(storage.availableBytes).toBeGreaterThan(0);

  expect(info).toEqual({
    version: packageJson.version,
    ramBudgetMib: 16_384,
    ramUsedMib: 0,
    ramReservedMib: 0,
    ramCommittedMib: 0,
    ramSleepingMib: 0,
    awakeCount: 0,
    impCount: 0,
    sessionCount: 0,
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0 } },
    firecrackerVersion: 'v1.17.0',
    ...TEST_SYSTEM_FILES,
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
    cpu: { hostCpus: 8, limitsEnforced: false },
    defaults: { memoryMib: 2048, image: null },
    egress: { isEnforced: true },
    public: null,
    https: null,
    features: {
      sessionOffsets: true,
      leases: true,
      grantableTokens: true,
      secretRebind: true,
      databaseCopy: true,
      imageBuildStream: true,
      imageOpStream: true,
      execRequire: true,
      oauthGrants: true,
      secretFilesGc: true,
    },
    ksm: null,
  });
});

test('it rejects a request with the wrong token', async () => {
  await using ctx = await setupTest('wrong');

  const rejection = await ctx.client.system.info().catch((error: unknown) => error);

  expect(rejection).toMatchObject({ status: 401 });
});

test('it answers /health without a token', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const response = await ctx.app.handle(new Request('http://impd.test/health'));
  const body: unknown = await response.json();

  expect(body).toEqual({ status: 'ok', ready: true });
});

test('it creates, stops, starts and destroys an imp', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  expect(created).toMatchObject({
    name: 'dev',
    image: 'ubuntu',
    state: 'running',
    slot: 0,
    ip: '10.66.0.2',
    port: 20_000,
    url: 'http://dev.imp.localhost:7080',
    ramMib: 300,
    rssMib: 340,
  });

  expect(ctx.taps).toEqual(['imp0']);

  const stopped = await ctx.client.imps.stop({ name: 'dev' });

  expect(stopped.state).toBe('stopped');
  expect(ctx.fake.stops).toEqual([{ pid: 1001, graceful: true }]);

  const started = await ctx.client.imps.start({ name: 'dev' });
  const info = await ctx.client.system.info();

  expect(started.state).toBe('running');

  expect(info).toMatchObject({
    impCount: 1,
    awakeCount: 1,
    ramUsedMib: 300,
    ramCommittedMib: 2048,
  });

  await ctx.client.imps.destroy({ name: 'dev' });

  const imps = await ctx.client.imps.list();

  expect(imps).toEqual([]);
  expect(ctx.fake.alive.size).toBe(0);
});

test('it reports the https URL when impd has a domain', async () => {
  await using plain = await setupTest(TEST_TOKEN);

  await plain.createTestImage('ubuntu');
  await plain.client.imps.create({ name: 'box' });

  const plainUrls = await plain.client.imps.url({ name: 'box' });

  expect(plainUrls).toEqual({
    local: 'http://box.imp.localhost:7080',
    https: null,
    public: null,
    service: null,
    tailnet: null,
  });

  await using ctx = await setupTest(TEST_TOKEN, {
    IMP_DOMAIN: 'imp.example.com',
    IMP_DNS_PROVIDER: 'cloudflare',
    IMP_DNS_API_TOKEN: 'unused',
  });

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'box' });

  const urls = await ctx.client.imps.url({ name: 'box' });

  expect(urls.https).toBe('https://box.imp.example.com');
});

test('without its DNS token file, the API still answers and system.info names the file as an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-dns-token-'));
  const tokenPath = join(dir, 'dns-api-token');

  try {
    await using ctx = await setupTest(TEST_TOKEN, {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN_FILE: tokenPath,
    });

    const missing = await ctx.client.system.info();

    expect(missing.https?.domain).toBe('imp.example.com');

    expect(missing.https?.dnsToken).toMatchObject({
      isOk: false,
      error: `cannot read the DNS API token from ${tokenPath}: ENOENT`,
    });

    // the operator puts the token in place; the next ask sees it, with no
    // restart, and never shows it
    writeFileSync(tokenPath, 'cf-secret-token\n');

    const fixed = await ctx.client.system.info();

    expect(fixed.https?.dnsToken?.isOk).toBe(true);
    expect(JSON.stringify([missing, fixed])).not.toContain('cf-secret-token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PUBLIC_ENV = {
  IMP_DOMAIN: 'imp.example.com',
  IMP_DNS_PROVIDER: 'cloudflare',
  IMP_DNS_API_TOKEN: 'unused',
  IMP_PUBLIC_IP: '203.0.113.7',
};

test('expose makes an imp public with a credential shown once, and unexpose ends it', async () => {
  await using ctx = await setupTest(TEST_TOKEN, PUBLIC_ENV);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'web' });

  const exposed = await ctx.client.imps.expose({ name: 'web', auth: 'basic' });

  expect(exposed).toMatchObject({
    url: 'https://web.imp.example.com',
    auth: 'basic',
    user: 'imp',
  });

  expect(exposed.credential).toMatch(/^[\w-]{43}$/);

  const imp = await ctx.client.imps.get({ name: 'web' });
  const urls = await ctx.client.imps.url({ name: 'web' });
  const info = await ctx.client.system.info();

  expect(imp.public).toEqual({ auth: 'basic' });
  expect(urls.public).toBe('https://web.imp.example.com');
  expect(info.public).toEqual({ ip: '203.0.113.7', imps: 1, records: null });

  // a token from the env has nothing to check
  expect(info.https).toEqual({ domain: 'imp.example.com', dnsToken: null });

  // only a hash is kept
  const row = await ctx.db
    .selectFrom('imps')
    .select(['public_hash', 'public_user'])
    .executeTakeFirstOrThrow();

  expect(row.public_user).toBe('imp');
  expect(row.public_hash).not.toContain(exposed.credential ?? '');

  // a second expose gives a new credential
  const again = await ctx.client.imps.expose({ name: 'web', auth: 'token' });

  expect(again).toMatchObject({ auth: 'token', user: null });
  expect(again.credential).not.toBe(exposed.credential);

  const unexposed = await ctx.client.imps.unexpose({ name: 'web' });

  expect(unexposed.public).toBeUndefined();

  const after = await ctx.client.imps.url({ name: 'web' });

  expect(after.public).toBeNull();
});

test('expose needs public mode, a known imp, and a user only with basic auth', async () => {
  await using plain = await setupTest(TEST_TOKEN);

  await plain.createTestImage('ubuntu');
  await plain.client.imps.create({ name: 'web' });

  const off = await plain.client.imps
    .expose({ name: 'web', auth: 'none' })
    .catch((error: unknown) => error);

  expect(off).toMatchObject({ code: 'PRECONDITION_FAILED' });

  const plainInfo = await plain.client.system.info();

  expect(plainInfo.public).toBeNull();
  expect(plainInfo.https).toBeNull();

  await using ctx = await setupTest(TEST_TOKEN, PUBLIC_ENV);

  const unknown = await ctx.client.imps
    .expose({ name: 'nope', auth: 'none' })
    .catch((error: unknown) => error);

  const stray = await ctx.client.imps
    .expose({ name: 'nope', auth: 'token', user: 'ann' })
    .catch((error: unknown) => error);

  expect(unknown).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'imp', name: 'nope' } });
  expect(stray).toMatchObject({ code: 'BAD_REQUEST' });
});

test('it prefers the configured default image and falls back to ubuntu', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');

  const first = await ctx.client.imps.create({ name: 'a' });

  await ctx.createTestImage('base');

  const second = await ctx.client.imps.create({});

  expect(first.image).toBe('ubuntu');
  expect(second.image).toBe('base');
  expect(second.name).toMatch(/^imp-[a-z0-9]{4}$/);
});

test('it rejects a duplicate name and an unknown image', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const duplicate = await ctx.client.imps.create({ name: 'dev' }).catch((error: unknown) => error);

  const unknown = await ctx.client.imps
    .create({ name: 'other', image: 'nope' })
    .catch((error: unknown) => error);

  expect(duplicate).toMatchObject({ code: 'CONFLICT', data: { kind: 'imp', name: 'dev' } });
  expect(unknown).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'image', name: 'nope' } });
});

test('it marks a running imp stopped when its VM died', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.alive.clear();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('stopped');
});

test('it refuses to remove an image an imp uses', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const rejection = await ctx.client.images
    .delete({ name: 'ubuntu' })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'CONFLICT' });
});

test('images.add with an imp makes a template that imps.create takes', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const template = await ctx.client.images.add({ imp: 'dev', name: 'tools' });

  expect(template).toMatchObject({ name: 'tools', ref: 'imp:dev', source: 'imp' });

  const copy = await ctx.client.imps.create({ name: 'copy', image: 'tools' });

  expect(copy.image).toBe('tools');

  const images = await ctx.client.images.list();

  expect(images.map((image) => [image.name, image.source])).toEqual([
    ['tools', 'imp'],
    ['ubuntu', 'oci'],
  ]);
});

test('it sleeps, wakes and holds an imp', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const asleep = await ctx.client.imps.sleep({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');

  // placement reads what the sleepers take back on a wake, and the default
  const sleepingInfo = await ctx.client.system.info();

  expect(sleepingInfo).toMatchObject({
    ramSleepingMib: 2048,
    ramCommittedMib: 0,
    defaults: { memoryMib: 2048, image: 'ubuntu' },
  });

  expect(asleep.sleptAt).toBeInstanceOf(Date);
  expect(ctx.fake.alive.size).toBe(0);

  const awake = await ctx.client.imps.wake({ name: 'dev' });

  expect(awake).toMatchObject({ state: 'running', ramMib: 300 });
  expect(ctx.fake.wakes).toEqual([1002]);

  await ctx.client.imps.sleep({ name: 'dev' });

  const held = await ctx.client.imps.hold({ name: 'dev', seconds: 60 });

  expect(held.state).toBe('running');
  expect(held.holdUntil?.getTime()).toBeGreaterThan(Date.now() + 50_000);

  const released = await ctx.client.imps.hold({ name: 'dev', seconds: 0 });

  expect(released.holdUntil).toBeUndefined();
});

test('it boots cold when the snapshot belongs to another firecracker', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const metaPath = `${ctx.dataDir}/imps/${created.id}/snapshot/meta.json`;

  const meta = await Bun.file(metaPath).text();

  await Bun.write(metaPath, meta.replace('"v1.17.0"', '"v0.1.0"'));

  const awake = await ctx.client.imps.wake({ name: 'dev' });

  expect(awake.state).toBe('running');
  expect(ctx.fake.wakes).toEqual([]);
});

test('it sleeps the least recently active imp to fit a new one in the budget', async () => {
  // 300 MiB per awake imp, 50% of 512 MiB reserved per boot
  await using ctx = await setupTest(TEST_TOKEN, {
    IMP_RAM_BUDGET_MIB: '800',
    IMP_DEFAULT_MEMORY_MIB: '512',
  });

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'a' });
  await Bun.sleep(5);
  await ctx.client.imps.create({ name: 'b' });
  await Bun.sleep(5);
  await ctx.client.imps.create({ name: 'c' });

  const states = await ctx.client.imps.list();

  expect(states.map((imp) => [imp.name, imp.state])).toEqual([
    ['a', 'sleeping'],
    ['b', 'running'],
    ['c', 'running'],
  ]);

  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  const rejection = await ctx.client.imps.wake({ name: 'a' }).catch((error: unknown) => error);

  expect(rejection).toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { budgetMib: 800, requestedMib: 300 },
  });
});

test('a cold boot the budget turns away keeps the sleeping imp and its snapshot', async () => {
  await using ctx = await setupTest(TEST_TOKEN, {
    IMP_RAM_BUDGET_MIB: '800',
    IMP_DEFAULT_MEMORY_MIB: '512',
  });

  await ctx.createTestImage('ubuntu');

  const asleep = await ctx.client.imps.create({ name: 'a' });

  await ctx.client.imps.sleep({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.create({ name: 'c' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  // a snapshot from another firecracker: the wake falls back to a cold boot
  const metaPath = `${ctx.dataDir}/imps/${asleep.id}/snapshot/meta.json`;

  const meta = await Bun.file(metaPath).text();

  await Bun.write(metaPath, meta.replace('"v1.17.0"', '"v0.1.0"'));

  const rejection = await ctx.client.imps.wake({ name: 'a' }).catch((error: unknown) => error);

  // the raw row: a read through the service would repair a lost snapshot
  const row = await findImpByName(ctx.db, 'a');

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(row?.state).toBe('sleeping');
  expect(existsSync(metaPath)).toBeTrue();
});

test('it leaves nothing behind when an imp is larger than the RAM budget', async () => {
  await using ctx = await setupTest(TEST_TOKEN, { IMP_RAM_BUDGET_MIB: '800' });

  await ctx.createTestImage('ubuntu');

  const rejection = await ctx.client.imps
    .create({ name: 'huge', memoryMib: 900 })
    .catch((error: unknown) => error);

  const imps = await ctx.client.imps.list();

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED', data: { requestedMib: 900 } });
  expect(imps).toEqual([]);
  expect(readdirSync(`${ctx.dataDir}/imps`)).toEqual([]);

  // the name and the slot are free again
  const created = await ctx.client.imps.create({ name: 'huge', memoryMib: 512 });

  expect(created).toMatchObject({ state: 'running', slot: 0 });
});

test('it records a boot failure as the error state with its first line', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');

  ctx.fake.queue('boot', 'fail');

  const rejection = await ctx.client.imps.create({ name: 'dev' }).catch((error: unknown) => error);
  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(rejection).toBeInstanceOf(Error);
  expect(imp).toMatchObject({ state: 'error', error: 'boot failed: no agent' });

  const started = await ctx.client.imps.start({ name: 'dev' });

  expect(started.state).toBe('running');
});

test('it re-adopts live VMs on reconcile, even with a silent agent', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'alive' });
  await ctx.client.imps.create({ name: 'dead' });
  await ctx.client.imps.create({ name: 'asleep' });
  await ctx.client.imps.sleep({ name: 'asleep' });

  const dead = await ctx.client.imps.get({ name: 'dead' });

  ctx.fake.alive.delete(1002);
  ctx.fake.queue('agentReady', 'fail');

  await ctx.imps.reconcileImps();

  const imps = await ctx.client.imps.list();

  expect(imps.map((imp) => [imp.name, imp.state])).toEqual([
    ['alive', 'running'],
    ['asleep', 'sleeping'],
    ['dead', 'stopped'],
  ]);

  expect(dead.state).toBe('running');
  expect(ctx.fake.stops).toEqual([]);
});

test('a read during a lifecycle operation does not mark the imp stopped', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const gate = ctx.fake.hold('sleep');
  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  await gate.reached;

  // the VM looks dead to a reader while the sleep holds the lock
  ctx.fake.alive.clear();

  const during = await ctx.client.imps.get({ name: 'dev' });

  gate.release();

  const after = await sleeping;

  expect(during.state).toBe('running');
  expect(after.state).toBe('sleeping');
});

test('impd stopping closes exec sessions with 1012', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/exec`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<CloseEvent>();

    socket.addEventListener('open', () => {
      opened.resolve();
    });

    socket.addEventListener('close', closed.resolve);

    await opened.promise;

    ctx.closeExecSessions();

    const event = await closed.promise;

    expect(event.code).toBe(1012);
  } finally {
    await server.stop(true);
  }
});

test('an exec ticket opens one socket for its imp, once', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    await ctx.createTestImage('ubuntu');
    await ctx.client.imps.create({ name: 'other' });

    const issued = await ctx.client.exec.ticket({ name: 'other' });

    // accepted at the upgrade, refused at start: the ticket names another imp
    const first = await tryExecSocket(port, `ticket=${issued.ticket}`);

    const forbidden: unknown = JSON.parse(first);

    expect(forbidden).toMatchObject({ type: 'error', code: 'FORBIDDEN' });

    const reused = await tryExecSocket(port, `ticket=${issued.ticket}`);

    expect(reused).toBe('rejected');
  } finally {
    await server.stop(true);
  }
});

test('an exec on a ticket the token asked for is audited as the token', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    await ctx.createTestImage('ubuntu');
    await ctx.client.imps.create({ name: 'dev' });

    const issued = await ctx.client.exec.ticket({ name: 'dev' });

    await tryExecSocket(port, `ticket=${issued.ticket}`);

    // the row lands after the open settles
    const deadline = Date.now() + 5000;
    let execs: { readonly actor: string }[] = [];

    while (execs.length === 0 && Date.now() < deadline) {
      const calls = await listApiCalls(ctx.db, 'dev', 10, null);

      execs = calls.filter((call) => call.procedure === 'exec');

      await Bun.sleep(1);
    }

    expect(execs.map((call) => call.actor)).toEqual(['token']);
  } finally {
    await server.stop(true);
  }
});

test('a bearer exec socket may start any imp', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    const reply = await tryExecSocket(port, '', 'other', { authorization: `Bearer ${TEST_TOKEN}` });

    const message: unknown = JSON.parse(reply);

    // past the grant: the imp does not exist
    expect(message).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
  } finally {
    await server.stop(true);
  }
});

test('/exec rejects an expired ticket and the token in the query', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    await ctx.createTestImage('ubuntu');
    await ctx.client.imps.create({ name: 'dev' });

    const issued = await ctx.client.exec.ticket({ name: 'dev' });

    ctx.advance(30_000);

    const expired = await tryExecSocket(port, `ticket=${issued.ticket}`);
    const queryToken = await tryExecSocket(port, `token=${TEST_TOKEN}`);

    expect(expired).toBe('rejected');
    expect(queryToken).toBe('rejected');
  } finally {
    await server.stop(true);
  }
});

test('/tunnel takes the bearer header only, not a ticket', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    await ctx.createTestImage('ubuntu');
    await ctx.client.imps.create({ name: 'dev' });

    const issued = await ctx.client.exec.ticket({ name: 'dev' });
    const ticket = await tryTunnelSocket(port, `ticket=${issued.ticket}`, {});
    const bearer = await tryTunnelSocket(port, '', { authorization: `Bearer ${TEST_TOKEN}` });

    const message: unknown = JSON.parse(bearer);

    expect(ticket).toBe('rejected');

    // past the auth: the imp does not exist
    expect(message).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
  } finally {
    await server.stop(true);
  }
});

test('a tunnel open is audited as the token, with the imp and the port', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    await ctx.createTestImage('ubuntu');
    await ctx.client.imps.create({ name: 'dev' });

    await tryTunnelSocket(port, '', { authorization: `Bearer ${TEST_TOKEN}` }, 'dev');

    // the row lands after the open settles
    const deadline = Date.now() + 5000;
    let tunnels: { readonly procedure: string; readonly actor: string }[] = [];

    while (tunnels.length === 0 && Date.now() < deadline) {
      const calls = await listApiCalls(ctx.db, 'dev', 10, null);

      tunnels = calls.filter((call) => call.procedure.startsWith('tunnel'));

      await Bun.sleep(1);
    }

    expect(tunnels.map((call) => [call.procedure, call.actor])).toEqual([['tunnel:5432', 'token']]);
  } finally {
    await server.stop(true);
  }
});

test('impd stopping closes tunnels with 1012', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const server = ctx.app.listen(0);

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${String(server.server?.port)}/tunnel`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<CloseEvent>();

    socket.addEventListener('open', () => {
      opened.resolve();
    });

    socket.addEventListener('close', closed.resolve);

    await opened.promise;

    ctx.closeExecSessions();

    const event = await closed.promise;

    expect(event.code).toBe(1012);
  } finally {
    await server.stop(true);
  }
});

test('exec.ticket refuses an imp that does not exist', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  const rejection = await ctx.client.exec.ticket({ name: 'nope' }).catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'NOT_FOUND' });
});

test('wake with restartError false refuses an imp in error', async () => {
  await using ctx = await setupTest(TEST_TOKEN);

  await ctx.createTestImage('ubuntu');

  ctx.fake.queue('boot', 'fail');

  await ctx.client.imps.create({ name: 'dev' }).catch(() => {});

  const rejection = await ctx.client.imps
    .wake({ name: 'dev', restartError: false })
    .catch((error: unknown) => error);

  const restarted = await ctx.client.imps.wake({ name: 'dev' });

  expect(rejection).toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'error', allowed: ['running', 'sleeping', 'stopped'] },
  });

  expect(restarted.state).toBe('running');
});
