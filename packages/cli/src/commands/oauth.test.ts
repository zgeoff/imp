import { expect, mock, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalCodeSchema } from '@imp/api';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { createImpClient } from '@zgeoff/imp-client';
import { runCli } from '../test-utils/start-cli';
import { UsageError } from '../usage-error';
import { runApprove } from './oauth';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-oauth-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),

    // the public MCP route a sign-in is for; nothing listens on it
    IMP_MCP_PUBLIC_URL: 'http://127.0.0.1:7171',
    IMP_MCP_PUBLIC_PORT: '7171',
  });

  // the system drive impd boots imps with
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

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

    // the host's free space, so a create never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // a frozen clock, so a sign-in's times are known
    now: () => Date.UTC(2026, 0, 1),
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
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
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

  const owned = stack.move();

  return {
    oauth: impd.oauth,

    // a client of impd's API for the token with this secret
    connect: (token: string) =>
      createImpClient({
        url: 'http://impd.test',
        token,
        fetch: (request) => impd.api.app.handle(request),
      }),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it refuses without a terminal or --yes before it calls impd', () => {
  const client = createImpClient({ url: 'http://127.0.0.1:1' });

  const prompt = {
    isTerminal: false,
    confirm: mock(() => Promise.resolve(true)),
    show: mock<(line: string) => void>(),
  };

  expect(
    runApprove(
      client,
      { code: 'ABCDEFGH', scope: 'exec', imps: undefined, isConfirmed: false },
      prompt,
    ),
  ).rejects.toThrowWithMessage(
    UsageError,
    'imp oauth approve asks before it approves, and stdin is not a terminal; pass --yes to approve without asking',
  );
});

test('it shows the sign-in and approves nothing when the answer at a terminal is no', async () => {
  await using ctx = await setupTest();

  const root = ctx.connect('root-token');

  const added = await root.oauth.clients.add({
    name: 'conn',
    redirectUris: ['https://client.example/callback'],
  });

  const made = await root.tokens.create({ name: 'approver', scope: 'manage' });

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: added.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'exec',
    resource: 'http://127.0.0.1:7171/mcp',
  });

  if (started.kind !== 'page') {
    throw new Error(`the sign-in did not start: ${started.kind}`);
  }

  const code = ApprovalCodeSchema.parse(started.view.approvalCode);
  const show = mock<(line: string) => void>();
  const confirm = mock(() => Promise.resolve(false));
  const approver = ctx.connect(made.secret);

  const approving = runApprove(
    approver,
    { code, scope: 'exec', imps: ['dev-*'], isConfirmed: false },
    { isTerminal: true, confirm, show },
  );

  expect(approving).rejects.toThrowWithMessage(Error, 'not approved; nothing changed');
  expect(confirm).toHaveBeenCalledExactlyOnceWith('Approve this sign-in? [y/N] ');

  expect(show.mock.calls).toStrictEqual([
    [
      [
        'client:       conn',
        'returns to:   https://client.example/callback',
        'asks for:     up to exec',
        'started:      2026-01-01T00:00:00.000Z',
        'ends:         2026-01-01T00:10:00.000Z',
      ].join('\n'),
    ],
    ['it gets:      exec on dev-*'],
  ]);
});

test('it approves what it showed when the answer at a terminal is yes', async () => {
  await using ctx = await setupTest();

  const root = ctx.connect('root-token');

  const added = await root.oauth.clients.add({
    name: 'conn',
    redirectUris: ['https://client.example/callback'],
  });

  const made = await root.tokens.create({ name: 'approver', scope: 'manage' });

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: added.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'exec',
    resource: 'http://127.0.0.1:7171/mcp',
  });

  if (started.kind !== 'page') {
    throw new Error(`the sign-in did not start: ${started.kind}`);
  }

  const code = ApprovalCodeSchema.parse(started.view.approvalCode);
  const show = mock<(line: string) => void>();
  const approver = ctx.connect(made.secret);

  await runApprove(
    approver,
    { code, scope: 'exec', imps: ['dev-*'], isConfirmed: false },
    { isTerminal: true, confirm: () => Promise.resolve(true), show },
  );

  expect(show).toHaveBeenLastCalledWith(
    'imp: approved: conn gets exec on dev-*; press Continue on the sign-in page',
  );

  expect(approver.oauth.approvals.approve({ code, scope: 'exec' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test.each([
  ['without', false],
  ['with', true],
])('it approves without asking for --yes %s a terminal', async (_case, isTerminal) => {
  await using ctx = await setupTest();

  const root = ctx.connect('root-token');

  const added = await root.oauth.clients.add({
    name: 'conn',
    redirectUris: ['https://client.example/callback'],
  });

  const made = await root.tokens.create({ name: 'approver', scope: 'manage' });

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: added.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'exec',
    resource: 'http://127.0.0.1:7171/mcp',
  });

  if (started.kind !== 'page') {
    throw new Error(`the sign-in did not start: ${started.kind}`);
  }

  const code = ApprovalCodeSchema.parse(started.view.approvalCode);
  const confirm = mock(() => Promise.resolve(false));
  const show = mock<(line: string) => void>();

  await runApprove(
    ctx.connect(made.secret),
    { code, scope: 'exec', imps: undefined, isConfirmed: true },
    { isTerminal, confirm, show },
  );

  expect(confirm).not.toHaveBeenCalled();

  expect(show).toHaveBeenLastCalledWith(
    "imp: approved: conn gets exec on the token's imps; press Continue on the sign-in page",
  );
});

test('it refuses an approval of more than a read token holds', async () => {
  await using ctx = await setupTest();

  const root = ctx.connect('root-token');

  const added = await root.oauth.clients.add({
    name: 'conn',
    redirectUris: ['https://client.example/callback'],
  });

  const made = await root.tokens.create({ name: 'reader', scope: 'read' });

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: added.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'exec',
    resource: 'http://127.0.0.1:7171/mcp',
  });

  if (started.kind !== 'page') {
    throw new Error(`the sign-in did not start: ${started.kind}`);
  }

  const code = ApprovalCodeSchema.parse(started.view.approvalCode);

  expect(
    runApprove(
      ctx.connect(made.secret),
      { code, scope: 'exec', imps: undefined, isConfirmed: true },
      { isTerminal: false, confirm: () => Promise.resolve(true), show: () => {} },
    ),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token reader has read, so it may approve that or less',
  });
});

test.each([
  [
    'an http redirect URI off loopback',
    ['client', 'add', 'conn', '--redirect-uri', 'http://client.example/cb'],
    'imp: --redirect-uri takes https URLs, or http on a loopback host, with no fragment; not http://client.example/cb',
  ],
  [
    'a redirect URI with a fragment',
    ['client', 'set', 'conn', '--redirect-uri', 'https://client.example/cb#x'],
    'imp: --redirect-uri takes https URLs, or http on a loopback host, with no fragment; not https://client.example/cb#x',
  ],
  [
    'a code that is not a sign-in code',
    ['approve', 'ABCD-EFG0'],
    'imp: ABCD-EFG0 is not a sign-in code; it looks like ABCD-EFGH',
  ],
  [
    'an unknown scope',
    ['approve', 'ABCD-EFGH', '--scope', 'admin'],
    'imp: --scope must be one of read, exec, manage',
  ],
  [
    'an imp pattern with an inner star',
    ['approve', 'ABCD-EFGH', '--imps', 'd*v'],
    'imp: --imps takes imp names, or a name prefix and a trailing *, such as dev-*; not d*v',
  ],
])('it refuses %s before it calls impd', async (_case, args, message) => {
  const result = await runCli({ args: ['oauth', ...args], env: { IMP_URL: 'http://127.0.0.1:1' } });

  expect(result).toStrictEqual({ stdout: '', stderr: `${message}\n`, code: 2 });
});
