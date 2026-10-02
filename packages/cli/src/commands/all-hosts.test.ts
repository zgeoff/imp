import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHostConfig } from '../host-store';

const MAIN = join(import.meta.dir, '..', 'main.ts');
const TOKEN = 'all-hosts-secret-token';

// the fields `imp ls` prints; the CLI does not check impd's answer
function buildImp(name: string, slot = 0) {
  return {
    name,
    state: 'running',
    image: 'base',
    vcpus: 1,
    memoryMib: 512,
    diskMib: 32_768,
    ip: `10.66.0.${String(slot + 2)}`,
    url: `http://${name}.imp.localhost:7080`,
  };
}

type FakeImp = Readonly<ReturnType<typeof buildImp>>;

interface FakeHost {
  readonly imps: readonly FakeImp[];
  readonly ramBudgetMib?: number;
  readonly images?: readonly string[];

  // imps.create answers RAM_BUDGET_EXCEEDED, as a full host's governor does
  readonly isFull?: boolean;

  // the token's imp patterns; null for a whole-host token
  readonly tokenImps?: readonly string[] | null;

  // imps.expose answers PRECONDITION_FAILED, as an impd without a public IP does
  readonly cannotExpose?: boolean;
}

// what an impd answers for a refused call
function buildRpcError(code: string, status: number, message: string) {
  return Response.json({ json: { defined: false, code, status, message } }, { status });
}

// An impd that speaks oRPC's RPC protocol for the calls `ls --all` and
// `new --place` make, for the right token, and records each create
function startImpd(host: FakeHost) {
  const creates: unknown[] = [];
  const exposes: unknown[] = [];

  const answers: Readonly<Record<string, unknown>> = {
    'imps/list': host.imps,
    'images/list': (host.images ?? ['base']).map((name) => ({ name })),
    'tokens/whoami': { kind: 'token', name: 'root', scope: 'manage', imps: host.tokenImps ?? null },
    'imps/expose': {
      url: 'https://dev.example.com',
      auth: 'token',
      user: null,
      credential: 'expose-credential',
    },
    'system/info': {
      version: '0.12.0',
      ramBudgetMib: host.ramBudgetMib ?? 8192,
      ramUsedMib: 0,
      ramReservedMib: 0,
      ramSleepingMib: 0,
      storage: { isLow: false },
      defaults: { memoryMib: 512, image: 'base' },
      egress: { isEnforced: true },
    },
  };

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json({ json: { message: 'unauthorized' } }, { status: 401 });
      }

      const path = new URL(request.url).pathname.replace(/^\/rpc\//u, '');

      if (path === 'imps/expose') {
        const body: unknown = await request.json();

        exposes.push(body);

        if (host.cannotExpose === true) {
          return buildRpcError('PRECONDITION_FAILED', 412, 'IMP_PUBLIC_IP is not set');
        }
      }

      if (path !== 'imps/create') {
        return Response.json({ json: answers[path] ?? null });
      }

      const body: unknown = await request.json();

      creates.push(body);

      if (host.isFull === true) {
        const error = {
          defined: true,
          code: 'RAM_BUDGET_EXCEEDED',
          status: 503,
          message: 'Not enough RAM budget, even after sleeping idle imps',
          data: { budgetMib: 8192, usedMib: 8000, requestedMib: 512 },
        };

        return Response.json({ json: error }, { status: 503 });
      }

      return Response.json({ json: buildImp('dev') });
    },
  });

  return { url: `http://localhost:${String(server.port)}`, server, creates, exposes };
}

// a host that takes the connection and never answers, as a sleeping laptop's
// impd does from behind a stalled tailnet path
function startSilentImpd() {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });

  return { url: `http://localhost:${String(server.port)}`, server };
}

// `withSilent` adds a saved host that never answers
function setupTest(hosts: Readonly<Record<string, FakeHost>>, withSilent = false) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-all-hosts-'));
  const env = { XDG_CONFIG_HOME: dir };

  const impds = Object.fromEntries(
    Object.entries(hosts).map(([name, host]) => [name, startImpd(host)]),
  );

  const saved = Object.entries(impds).map(
    ([name, impd]) => [name, { url: impd.url, token: TOKEN }] as const,
  );

  const silent = withSilent ? startSilentImpd() : null;

  writeHostConfig(env, {
    current: Object.keys(hosts)[0] ?? null,
    hosts: {
      ...Object.fromEntries(saved),
      gone: { url: 'http://127.0.0.1:1', token: TOKEN },
      ...(silent !== null && { silent: { url: silent.url, token: TOKEN } }),
    },
  });

  const run = async (args: readonly string[]) => {
    const child = Bun.spawn(['bun', MAIN, ...args], {
      env: { PATH: process.env['PATH'] ?? '', HOME: dir, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { stdout, stderr, code };
  };

  const stopAll = async () => {
    for (const impd of Object.values(impds)) {
      await impd.server.stop(true);
    }

    await silent?.server.stop(true);
  };

  return {
    impds,
    run,
    stopAll,
    [Symbol.asyncDispose]: async () => {
      await stopAll();

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// db carries fields this CLI's schema lacks, as a newer impd's imp does; its
// `host` must not replace the saved host's name
const TWO_HOSTS = {
  box: { imps: [buildImp('web', 0), { ...buildImp('db', 1), move: 'sending', host: 'peer' }] },
  laptop: { imps: [buildImp('dev', 0)] },
};

// the silent host costs the 5 s that each host gets
test('ls --all lists every saved host, says which failed, and exits 3 for a partial list', async () => {
  await using ctx = setupTest(TWO_HOSTS, true);

  const started = performance.now();

  const listed = await ctx.run(['ls', '--all']);

  // the timeout, not a hang: the aborted request lets the process exit
  expect(performance.now() - started).toBeLessThan(8000);

  const rows = listed.stdout.trimEnd().split('\n');

  expect(rows.map((row) => row.split(/\s+/u).slice(0, 3))).toEqual([
    ['HOST', 'NAME', 'STATE'],
    ['box', 'web', 'running'],
    ['box', 'db', 'running'],
    ['laptop', 'dev', 'running'],
  ]);

  const failed = listed.stderr.trimEnd().split('\n');

  expect(failed).toHaveLength(2);
  expect(failed[0]).toStartWith('imp: gone: ');
  expect(failed[1]).toBe('imp: silent: no answer in 5 s');
  expect(listed.stdout + listed.stderr).not.toContain(TOKEN);
  expect(listed.code).toBe(3);
}, 15_000);

test('ls --all --json always writes the imps and the errors', async () => {
  await using ctx = setupTest(TWO_HOSTS);

  const listed = await ctx.run(['ls', '--all', '--json']);

  const body: unknown = JSON.parse(listed.stdout);

  expect(body).toEqual({
    imps: [
      { host: 'box', ...buildImp('web', 0) },
      { host: 'box', ...buildImp('db', 1), move: 'sending' },
      { host: 'laptop', ...buildImp('dev', 0) },
    ],
    errors: [{ host: 'gone', message: expect.any(String) as unknown }],
  });

  expect(listed.code).toBe(3);

  await ctx.stopAll();

  // no host answered: the JSON still comes, and the exit is a failure
  const none = await ctx.run(['ls', '--all', '--json']);

  expect(JSON.parse(none.stdout)).toMatchObject({ imps: [] });
  expect(none.stderr.trimEnd().split('\n')).toHaveLength(3);
  expect(none.code).toBe(1);
});

test('--all and --place with --host are usage errors, and plain ls stays one host', async () => {
  await using ctx = setupTest(TWO_HOSTS);

  const all = await ctx.run(['--host', 'box', 'ls', '--all']);
  const place = await ctx.run(['--host', 'box', 'new', 'dev', '--place']);

  expect(all).toEqual({
    stdout: '',
    stderr: 'imp: --all lists every saved host; drop --host\n',
    code: 2,
  });

  expect(place).toEqual({
    stdout: '',
    stderr: 'imp: --place picks among the saved hosts; drop --host\n',
    code: 2,
  });

  const plain = await ctx.run(['ls', '--json']);

  const body: unknown = JSON.parse(plain.stdout);

  expect(body).toEqual([
    buildImp('web', 0),
    { ...buildImp('db', 1), move: 'sending', host: 'peer' },
  ]);

  expect(plain.code).toBe(0);
});

test('new --place skips what cannot take the imp, and moves past a RAM refusal', async () => {
  await using ctx = setupTest({
    big: { imps: [], ramBudgetMib: 32_768, isFull: true },
    small: { imps: [] },
    bare: { imps: [], ramBudgetMib: 65_536, images: ['ubuntu'] },
  });

  const placed = await ctx.run(['new', 'dev', '--place', '--json']);

  expect(placed.stderr.split('\n').filter((line) => !line.startsWith('imp: gone:'))).toEqual([
    'imp: bare: skipped: it has no image base',
    'imp: placing on big',
    'imp: big: Not enough RAM budget, even after sleeping idle imps; trying the next host',
    'imp: placing on small',
    '',
  ]);

  expect(JSON.parse(placed.stdout)).toEqual({ host: 'small', imp: buildImp('dev') });
  expect(placed.code).toBe(0);

  // one create on each host it tried, none on the one it skipped
  expect(ctx.impds['big']?.creates).toHaveLength(1);
  expect(ctx.impds['small']?.creates).toEqual([{ json: { name: 'dev' } }]);
  expect(ctx.impds['bare']?.creates).toHaveLength(0);
});

test('new --place refuses a name a saved host has already', async () => {
  await using ctx = setupTest(TWO_HOSTS);

  const placed = await ctx.run(['new', 'dev', '--place']);

  expect(placed.stderr).toEndWith('imp: dev exists on laptop already; pick another name\n');
  expect(placed.code).toBe(1);
  expect(ctx.impds['box']?.creates).toHaveLength(0);
  expect(ctx.impds['laptop']?.creates).toHaveLength(0);
});

test('new --place --public passes over a host whose token is limited, then exposes', async () => {
  await using ctx = setupTest({
    big: { imps: [], ramBudgetMib: 65_536, tokenImps: ['dev*'] },
    small: { imps: [] },
  });

  const placed = await ctx.run(['new', 'dev', '--place', '--public', '--json']);

  expect(placed.stderr.split('\n').filter((line) => !line.startsWith('imp: gone:'))).toEqual([
    'imp: big: skipped: its token is limited to some imps, which --public and --net need it not to be',
    'imp: placing on small',
    '',
  ]);

  expect(JSON.parse(placed.stdout)).toEqual({
    host: 'small',
    imp: buildImp('dev'),
    public: {
      url: 'https://dev.example.com',
      auth: 'token',
      user: null,
      credential: 'expose-credential',
    },
  });

  expect(placed.code).toBe(0);
  expect(ctx.impds['big']?.creates).toHaveLength(0);
  expect(ctx.impds['small']?.exposes).toEqual([{ json: { name: 'dev', auth: 'token' } }]);
});

test('a failure after a placed create names the host, and --json still gets the imp', async () => {
  await using ctx = setupTest({ box: { imps: [], cannotExpose: true } });

  const placed = await ctx.run(['new', 'dev', '--place', '--public', '--json']);

  expect(placed.stderr).toEndWith(
    'imp: dev was created on box; PRECONDITION_FAILED: IMP_PUBLIC_IP is not set\n',
  );

  expect(JSON.parse(placed.stdout)).toEqual({
    host: 'box',
    imp: buildImp('dev'),
    error: 'PRECONDITION_FAILED: IMP_PUBLIC_IP is not set',
  });

  expect(placed.code).toBe(1);
});
