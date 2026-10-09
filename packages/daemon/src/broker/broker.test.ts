import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { buildMockBrokerRule } from '@imp/api/test-utils/build-mock-broker-rule';
import { server } from '@imp/test-utils/mock-server';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { HttpResponse, http } from 'msw';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { listAuditEntries } from '../db/broker-audit';
import { createImage } from '../db/images';
import { openDatabase } from '../db/open-database';
import { findSecret, listGrantNames, removeCheckedGrant } from '../db/secrets';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubBrokerGuest } from '../test-utils/build-stub-broker-guest';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubBrokerGuestSocket } from '../test-utils/start-stub-broker-guest-socket';
import { startStubBrokerHoldTarget } from '../test-utils/start-stub-broker-hold-target';
import { startStubBrokerPlainUpstream } from '../test-utils/start-stub-broker-plain-upstream';
import { startStubBrokerReplyTarget } from '../test-utils/start-stub-broker-reply-target';
import { startStubBrokerTlsUpstream } from '../test-utils/start-stub-broker-tls-upstream';
import { startStubBrokerTunnel } from '../test-utils/start-stub-broker-tunnel';
import { loadOrCreateBrokerCa } from './broker-ca';

// The broker end to end on loopback: with IMP_SUBNET 127.0.0.0/16, curl
// bound to 127.0.0.2 is slot 0's guest, and 127.0.0.1 its gateway. A fake
// upstream serves the granted host through the test-upstreams file.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'broker-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the real host past a plain tunnel, with a CA nobody trusts: the guest
  // must see a certificate the broker CA did not sign
  const tunnelled: { method: string; path: string; authorization: string | null }[] = [];

  const realHost = await startStubBrokerTlsUpstream(stack, {
    dir: join(dataDir, 'real-host'),
    host: 'api.github.com',
    fetch: (request) => {
      tunnelled.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
      });

      return new Response('from the real host');
    },
  });

  // the fake upstream, with its own CA the broker is told to trust
  const seen: { method: string; path: string; authorization: string | null; bodyBytes: number }[] =
    [];

  // a test's own answer for a path; any other path gets 'from upstream'
  const answers = new Map<string, () => Response | Promise<Response>>();

  const upstream = await startStubBrokerTlsUpstream(stack, {
    dir: join(dataDir, 'upstream'),
    fetch: async (request) => {
      const body = await request.arrayBuffer();

      const path = new URL(request.url).pathname;

      const response = await (answers.get(path) ?? (() => new Response('from upstream')))();

      seen.push({
        method: request.method,
        path,
        authorization: request.headers.get('authorization'),
        bodyBytes: body.byteLength,
      });

      return response;
    },
  });

  // the broker reads the file when a request comes
  const upstreamsFile = join(dataDir, 'upstreams.json');
  const upstreamOrigin = upstream.origin;

  await writeFile(
    upstreamsFile,
    JSON.stringify({ ca: upstream.caPem, upstreams: { 'api.github.com': upstreamOrigin } }),
  );

  // a loopback subnet, so a local address stands for a guest; the stub VMM
  // runs no jailer; each impd's resolver takes a free port
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    IMP_SUBNET: '127.0.0.0/16',
    IMP_BROKER_TEST_UPSTREAMS: upstreamsFile,
  });

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // what a request does between its rule read and its value read
  const ruleRead = { hook: (): Promise<void> => Promise.resolve() };

  // plain tunnels stay on loopback, and port 443 goes to the real host
  const tunnelPorts = new Map([[443, realHost.port]]);

  const impd = await createImpd(config, {
    db,
    rootToken: 'root-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.resolve('127.0.0.1'),
      dialTunnel: (address, port) =>
        createConnection({ host: address, port: tunnelPorts.get(port) ?? port }),
      afterRuleRead: () => ruleRead.hook(),
      runOAuthTimer: false,
    },
    egress: {
      runNft: () => Promise.resolve(),
      flushConnections: () => Promise.resolve(),
      flushPair: () => Promise.resolve(),
      readForwardRules: () => Promise.resolve(''),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
      readConnected4: () => Promise.resolve(['172.17.0.0/16']),
      readConnected6: () => Promise.resolve([]),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
    },
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  // the image every imp boots from
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const proxyPort = await impd.broker.listen(0);

  const caFile = join(dataDir, 'broker', 'ca', 'ca.pem');

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: 'Bearer root-token' },
    fetch: (request) => impd.api.app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return {
    stack,
    db,
    dataDir,
    impd,
    client,
    seen,
    tunnelled,
    answers,
    ruleRead,
    upstreamsFile,
    upstreamOrigin,
    proxyPort,
    caFile,

    // slot 0's guest
    guest: buildStubBrokerGuest({ proxyPort, caFile, address: '127.0.0.2' }),
  };
}

test('it sends the real credential in place of the placeholder to a granted host', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const result = await ctx.guest.curl('https://api.github.com/user?x=1', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'from upstream', stderr: '' });

  expect(ctx.seen).toStrictEqual([
    { method: 'GET', path: '/user', authorization: 'Bearer ghp_real', bodyBytes: 0 },
  ]);
});

test('it records an audit row for a forwarded request', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');
  await ctx.guest.curl('https://api.github.com/user?x=1');

  const audit: unknown = await waitFor(async () => {
    const rows = await listAuditEntries(ctx.db, dev.id, 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(audit).toStrictEqual([
    {
      at: expect.toBeValidDate() as unknown,
      imp: 'dev',
      secret: 'gh',
      method: 'GET',
      host: 'api.github.com',
      path: '/user',
      status: 200,
      requestBytes: 0,
      responseBytes: 'from upstream'.length,
      durationMs: expect.toBeNumber() as unknown,
    },
  ]);
});

test('it streams a large upload through and counts its bytes', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const body = join(ctx.dataDir, 'pack');

  await writeFile(body, Buffer.alloc(3 * 1024 * 1024 + 17, 7));

  await ctx.guest.curl('https://api.github.com/upload', ['--data-binary', `@${body}`]);

  const audit = await waitFor(async () => {
    const rows = await listAuditEntries(ctx.db, null, 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(ctx.seen.map((entry) => entry.bodyBytes)).toStrictEqual([3 * 1024 * 1024 + 17]);
  expect(audit.map((row) => row.requestBytes)).toStrictEqual([3 * 1024 * 1024 + 17]);
});

test('it tunnels an ungranted host, whose real certificate the guest does not trust', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const result = await ctx.guest.curl('https://api.github.com/user');

  expect(result).toStrictEqual({ code: 60, stdout: '', stderr: expect.toStartWith('curl: (60) ') });
  expect(ctx.tunnelled).toStrictEqual([]);
  expect(ctx.seen).toStrictEqual([]);
});

test('it adds no credential to an ungranted host the guest reaches past the certificate', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const result = await ctx.guest.curl('https://api.github.com/user', [
    '-k',
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'from the real host', stderr: '' });

  expect(ctx.tunnelled).toStrictEqual([
    { method: 'GET', path: '/user', authorization: 'Bearer imp-broker-placeholder' },
  ]);

  expect(ctx.seen).toStrictEqual([]);
});

test('it dials the checked address for a plain tunnel under an open policy', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });

  const result = await ctx.guest.curl(`http://plain.test:${String(target.port)}/`, [
    '--proxytunnel',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'tunnel', stderr: '' });
});

test('it relays the guest’s bytes to the tunnel target', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.guest.curl(`http://plain.test:${String(target.port)}/hello`, ['--proxytunnel']);

  // curl adds its own headers after the Host line
  expect(target.received).toStrictEqual([
    expect.toStartWith(`GET /hello HTTP/1.1\r\nHost: plain.test:${String(target.port)}\r\n`),
  ]);
});

test('it tunnels to a host a box policy lists', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.egress.setPolicy('dev', { mode: 'box', allow: ['plain.test'] });

  const result = await ctx.guest.curl(`http://plain.test:${String(target.port)}/`, [
    '--proxytunnel',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'tunnel', stderr: '' });
});

test('it refuses a tunnel to a host a box policy does not list', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.egress.setPolicy('dev', { mode: 'box', allow: ['other.test'] });

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: ctx.proxyPort,
    address: '127.0.0.2',
  });

  guest.write(
    `CONNECT plain.test:${String(target.port)} HTTP/1.1\r\nHost: plain.test:${String(target.port)}\r\n\r\n`,
  );

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 63\r\n' +
      "connection: close\r\n\r\negress to plain.test is not allowed by the imp's egress policy\n",
  );
});

test('it refuses every tunnel under a closed egress policy', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.egress.setPolicy('dev', { mode: 'none', allow: [] });

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: ctx.proxyPort,
    address: '127.0.0.2',
  });

  guest.write(
    `CONNECT plain.test:${String(target.port)} HTTP/1.1\r\nHost: plain.test:${String(target.port)}\r\n\r\n`,
  );

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 63\r\n' +
      "connection: close\r\n\r\negress to plain.test is not allowed by the imp's egress policy\n",
  );
});

test('it ends the open tunnels a tighter policy denies, and keeps the rest', async () => {
  const ctx = await setupTest();
  const target = await startStubBrokerHoldTarget(ctx.stack);

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.egress.setPolicy('dev', { mode: 'box', allow: ['keep.test', 'drop.test'] });

  const keep = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
    target: `keep.test:${String(target.port)}`,
  });

  const drop = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
    target: `drop.test:${String(target.port)}`,
  });

  keep.sendHead();
  drop.sendHead();

  await Promise.all([keep.established, drop.established]);
  await ctx.impd.egress.setPolicy('dev', { mode: 'box', allow: ['keep.test'] });

  await drop.closed;

  expect(keep.isOpen()).toBeTrue();
});

test('it gives no tunnel to a connection opened under an open policy once a tighter one is set', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const early = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.proxyPort,
    address: '127.0.0.2',
    target: 'late.test:9',
  });

  await ctx.impd.egress.setPolicy('dev', { mode: 'none', allow: [] });

  early.sendHead();

  expect(early.established).rejects.toThrow('HTTP/1.1 403 Forbidden');
});

test('it closes the connection of a guest on another imp’s gateway without a reply', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  // 127.0.0.6 is slot 1's guest, dialling slot 0's gateway
  const other = await startStubBrokerGuestSocket(ctx.stack, {
    port: ctx.proxyPort,
    address: '127.0.0.6',
  });

  other.write('CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n');

  const reply = await other.reply;

  expect(reply).toBe('');
});

test('it refuses a proxy request that is not a CONNECT', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const result = await ctx.guest.curl('http://api.github.com/user');

  expect(result).toStrictEqual({ code: 0, stdout: 'only CONNECT is served\n', stderr: '' });
  expect(ctx.seen).toStrictEqual([]);
});

test('it stops sending the credential as soon as the grant is revoked', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');
  await ctx.guest.curl('https://api.github.com/a');
  await ctx.impd.broker.removeGrant('dev', 'gh');

  // now a plain tunnel: the real host's certificate, which the guest does
  // not trust
  const result = await ctx.guest.curl('https://api.github.com/b');

  expect(result.code).toBe(60);
  expect(ctx.tunnelled).toStrictEqual([]);
  expect(ctx.seen.map((entry) => entry.path)).toStrictEqual(['/a']);
});

test('it passes a 204 through without a body', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  ctx.answers.set('/none', () => new Response(null, { status: 204 }));

  const result = await ctx.guest.curl('https://api.github.com/none', [
    '-w',
    '%{http_code} %{size_download}',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: '204 0', stderr: '' });
});

test('it passes a 304 through without a body', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  ctx.answers.set('/same', () => new Response(null, { status: 304 }));

  const result = await ctx.guest.curl('https://api.github.com/same', [
    '-w',
    '%{http_code} %{size_download}',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: '304 0', stderr: '' });
});

test('it passes a redirect through without following it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  ctx.answers.set(
    '/moved',
    () =>
      new Response(null, { status: 302, headers: { location: 'https://objects.example.com/x' } }),
  );

  const result = await ctx.guest.curl('https://api.github.com/moved', [
    '-w',
    '%{http_code} %{redirect_url}',
  ]);

  expect(result).toStrictEqual({
    code: 0,
    stdout: '302 https://objects.example.com/x',
    stderr: '',
  });

  expect(ctx.seen.map((entry) => entry.path)).toStrictEqual(['/moved']);
});

test('it gives no credential to the next request on a connection whose grant is gone', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  // the row goes while the upstream handles /a, and no prune runs, so the
  // connection stays: the lookup on each request is what refuses /b
  ctx.answers.set('/a', async () => {
    await removeCheckedGrant(ctx.db, dev.id, 'gh', null);

    return new Response('from upstream');
  });

  // /a then /b in one curl run, on one connection when it can
  const result = await ctx.guest.curl('https://api.github.com/b', [
    '-w',
    ' %{http_code} %{num_connects}\n',
    'https://api.github.com/a',
  ]);

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'from upstream 200 1\nno credential is granted for api.github.com\n 403 0\n',
    stderr: '',
  });

  expect(ctx.seen.map((entry) => entry.path)).toStrictEqual(['/a']);
});

test('it lets the request under way finish on a revoke, and the next gets no credential', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  // the revoke lands while the upstream handles /a; it waits for the grant
  // to go, not for the revoke's prune, which waits for /a to end
  const revoke = { done: Promise.resolve() };

  ctx.answers.set('/a', async () => {
    revoke.done = ctx.impd.broker.removeGrant('dev', 'gh');

    await waitFor(async () => {
      const names = await listGrantNames(ctx.db, dev.id);

      expect(names).toStrictEqual([]);
    });

    return new Response('from upstream');
  });

  const result = await ctx.guest.curl('https://api.github.com/b', [
    '-w',
    ' %{http_code} %{num_connects}\n',
    'https://api.github.com/a',
  ]);

  await revoke.done;

  // the prune closed the connection once /a was done: /b dialled again, got
  // a plain tunnel to the real host, and never trusted it (curl's 60)
  expect(result).toStrictEqual({
    code: 60,
    stdout: 'from upstream 200 1\n 000 1\n',
    stderr: expect.toStartWith('curl: (60) '),
  });

  expect(ctx.seen.map((entry) => entry.path)).toStrictEqual(['/a']);
  expect(ctx.tunnelled).toStrictEqual([]);
});

test('it never sends a rebound value to the host the secret had before', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'api',
    kind: 'custom',
    value: 'old-value',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.impd.broker.addGrant('dev', 'api');

  // the request holds between its rule read and its value read
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  ctx.ruleRead.hook = async () => {
    reached.resolve();

    await release.promise;
  };

  const request = ctx.guest.curl('https://api.github.com/x');

  await reached.promise;

  const replaced = ctx.impd.broker.addSecret({
    name: 'api',
    kind: 'custom',
    value: 'new-value',
    rules: [buildMockBrokerRule({ host: 'other.example.com' })],
    replace: true,
    rebind: true,
  });

  // the row has switched and the old file is gone; the replace itself then
  // waits for the held request, as a revoke's prune does
  await waitFor(async () => {
    const secret = await findSecret(ctx.db, 'api');
    const files = await readdir(join(ctx.dataDir, 'secrets'));

    expect(secret?.rules[0]?.host).toBe('other.example.com');
    expect(files).toHaveLength(1);
  });

  release.resolve();

  const [result] = await Promise.all([request, replaced]);

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'no credential is granted for api.github.com\n',
    stderr: '',
  });

  expect(ctx.seen).toStrictEqual([]);
});

test('it sends the rotated value on the next request, with the grant kept', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');
  await ctx.guest.curl('https://api.github.com/one');

  await ctx.impd.broker.addSecret({
    name: 'gh',
    kind: 'github',
    value: 'ghp_rotated',
    replace: true,
  });

  const result = await ctx.guest.curl('https://api.github.com/two');

  expect(result.code).toBe(0);

  expect(ctx.seen.map((entry) => `${entry.path} ${String(entry.authorization)}`)).toStrictEqual([
    '/one Bearer ghp_real',
    '/two Bearer ghp_rotated',
  ]);
});

test('it sends the request of a host with no public name to its rule’s upstream', async () => {
  const ctx = await setupTest();

  const received: { authorization: string | null; url: string }[] = [];

  server.use(
    http.get('http://svc-upstream.test:18081/v1/ping', (info) => {
      received.push({
        authorization: info.request.headers.get('authorization'),
        url: info.request.url,
      });

      return HttpResponse.text('from the rule upstream');
    }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://svc-upstream.test:18081' }),
    ],
  });

  await ctx.impd.broker.addGrant('dev', 'op');

  const result = await ctx.guest.curl('https://svc.imp.internal/v1/ping', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'from the rule upstream', stderr: '' });

  expect(received).toStrictEqual([
    { authorization: 'Bearer real-token', url: 'http://svc-upstream.test:18081/v1/ping' },
  ]);

  expect(ctx.seen).toStrictEqual([]);
});

test('it gives a rule’s upstream its own authority as the Host', async () => {
  const ctx = await setupTest();

  const hosts: (string | null)[] = [];

  const upstream = startStubBrokerPlainUpstream(ctx.stack, (request) => {
    hosts.push(request.headers.get('host'));

    return new Response('from the rule upstream');
  });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: upstream.origin })],
  });

  await ctx.impd.broker.addGrant('dev', 'op');
  await ctx.guest.curl('https://svc.imp.internal/v1/ping');

  expect(hosts).toStrictEqual([`127.0.0.1:${String(upstream.port)}`]);
});

test('it audits a request sent to a rule’s upstream under the guest’s host', async () => {
  const ctx = await setupTest();

  server.use(
    http.get('http://svc-upstream.test:18081/v1/ping', () =>
      HttpResponse.text('from the rule upstream'),
    ),
  );

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://svc-upstream.test:18081' }),
    ],
  });

  await ctx.impd.broker.addGrant('dev', 'op');
  await ctx.guest.curl('https://svc.imp.internal/v1/ping');

  const audit = await waitFor(async () => {
    const rows = await listAuditEntries(ctx.db, dev.id, 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(audit.map((row) => [row.secret, row.host, row.path])).toStrictEqual([
    ['op', 'svc.imp.internal', '/v1/ping'],
  ]);
});

test('it sends the next request to the host’s own origin once a rebind drops the upstream', async () => {
  const ctx = await setupTest();

  const received: string[] = [];

  server.use(
    http.get('http://svc-upstream.test:18081/v1/ping', () =>
      HttpResponse.text('from the rule upstream'),
    ),
    http.get('https://svc.imp.internal/v1/ping', (info) => {
      received.push(info.request.headers.get('authorization') ?? '');

      return HttpResponse.text('from the host itself');
    }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://svc-upstream.test:18081' }),
    ],
  });

  await ctx.impd.broker.addGrant('dev', 'op');
  await ctx.guest.curl('https://svc.imp.internal/v1/ping');

  await ctx.impd.broker.addSecret({
    name: 'op',
    kind: 'custom',
    value: 'real-token',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal' })],
    replace: true,
    rebind: true,
  });

  await ctx.impd.broker.addGrant('dev', 'op');

  const result = await ctx.guest.curl('https://svc.imp.internal/v1/ping');

  expect(result).toStrictEqual({ code: 0, stdout: 'from the host itself', stderr: '' });
  expect(received).toStrictEqual(['Bearer real-token']);
});

test('it refuses a test upstream whose certificate the file’s CA did not sign', async () => {
  const ctx = await setupTest();
  const otherCa = await loadOrCreateBrokerCa(join(ctx.dataDir, 'other-ca'));

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: otherCa.certPem, upstreams: { 'api.github.com': ctx.upstreamOrigin } }),
  );

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await ctx.impd.broker.addGrant('dev', 'gh');

  const result = await ctx.guest.curl('https://api.github.com/user');

  expect(result).toStrictEqual({ code: 0, stdout: 'could not reach api.github.com\n', stderr: '' });
  expect(ctx.seen).toStrictEqual([]);
});
