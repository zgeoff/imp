import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `token new --grantable`, `secret add --replace` and `exec --require` rely
// on fields an older impd drops unread, so the CLI checks impd's features
// before it writes or runs anything.

const MAIN = join(import.meta.dir, '..', 'main.ts');
const TOKEN = 'feature-gates-token';

// the secret and token impd answers with; the CLI does not check them
const SECRET = {
  name: 'gh',
  kind: 'github',
  rules: [],
  imps: [],
  createdAt: '2026-10-03T00:00:00.000Z',
  droppedGrants: 0,
};

const MADE_TOKEN = {
  token: {
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    sshKeys: [],
    grantable: ['gh'],
    createdAt: '2026-10-03T00:00:00.000Z',
  },
  secret: 'imp_made.token-secret',
};

const NEW_INFO = {
  version: '0.27.0',
  features: { sessionOffsets: true, leases: true, grantableTokens: true, secretRebind: true },
};

const OLD_INFO = { version: '0.26.0', features: { sessionOffsets: true, leases: true } };

// An impd that answers system.info with `info`, or fails it when `info` is
// 'fail', and records every call
function startImpd(info: unknown) {
  const calls: string[] = [];

  const answers: Readonly<Record<string, unknown>> = {
    'system/info': info,
    'tokens/create': MADE_TOKEN,
    'secrets/add': SECRET,
  };

  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname.replace(/^\/rpc\//u, '');

      calls.push(path);

      if (path === 'system/info' && info === 'fail') {
        return Response.json(
          { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'boom' } },
          { status: 500 },
        );
      }

      return Response.json({ json: answers[path] ?? null });
    },
  });

  return { url: `http://localhost:${String(server.port)}`, server, calls };
}

function setupTest(info: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-feature-gates-'));
  const impd = startImpd(info);

  const run = async (args: readonly string[], stdin = '') => {
    const child = Bun.spawn(['bun', MAIN, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        IMP_URL: impd.url,
        IMP_TOKEN: TOKEN,
      },
      stdin: new TextEncoder().encode(stdin),
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

  return {
    calls: impd.calls,
    run,
    [Symbol.asyncDispose]: async () => {
      await impd.server.stop(true);

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const GRANTER = ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*'];

test('--grantable without manage and imps, or with a bad name, is refused before any call', async () => {
  await using ctx = setupTest(NEW_INFO);

  const results = await Promise.all([
    ctx.run(['token', 'new', 'agent', '--scope', 'manage', '--grantable', 'gh']),
    ctx.run(['token', 'new', 'agent', '--scope', 'exec', '--imps', 'agent-*', '--grantable', 'gh']),
    ctx.run([...GRANTER, '--grantable', 'Not A Name']),
    ctx.run(['secret', 'add', 'gh', '--kind', 'github', '--rebind'], 'ghp_value\n'),
    ctx.run(['token', 'new', 'agent', '--scope', 'manage', '--imps', '', '--grantable', 'gh']),
    ctx.run(['token', 'new', 'agent', '--scope', 'manage', '--imps', ' , ', '--grantable', 'gh']),
  ]);

  expect(results.map((result) => result.code)).toEqual([2, 2, 2, 2, 2, 2]);
  expect(results[4]?.stderr).toContain('--imps takes imp names');
  expect(results[5]?.stderr).toContain('--imps takes imp names');
  expect(results[0]?.stderr).toContain('--grantable needs --scope manage and --imps');
  expect(results[2]?.stderr).toContain('--grantable takes secret names');
  expect(results[3]?.stderr).toContain('--rebind needs --replace');
  expect(ctx.calls).toEqual([]);
});

test('an older impd gets no token create and no secret replace, only the feature check', async () => {
  await using ctx = setupTest(OLD_INFO);

  const token = await ctx.run([...GRANTER, '--grantable', 'gh']);
  const replace = await ctx.run(['secret', 'add', 'gh', '--kind', 'github', '--replace'], 'v\n');

  const rebind = await ctx.run(
    ['secret', 'add', 'gh', '--kind', 'github', '--replace', '--rebind'],
    'v\n',
  );

  for (const result of [token, replace, rebind]) {
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('this impd is older than 0.27.0');
    expect(result.stderr).toContain('nothing was changed');
  }

  expect(ctx.calls).toEqual(['system/info', 'system/info', 'system/info']);
});

test('a new impd gets the token create and the secret replace after the check', async () => {
  await using ctx = setupTest(NEW_INFO);

  const token = await ctx.run([...GRANTER, '--grantable', 'gh']);
  const replace = await ctx.run(['secret', 'add', 'gh', '--kind', 'github', '--replace'], 'v\n');

  // a plain add needs no check
  const add = await ctx.run(['secret', 'add', 'gh', '--kind', 'github'], 'v\n');

  expect([token.code, replace.code, add.code]).toEqual([0, 0, 0]);
  expect(token.stdout.trim()).toBe(MADE_TOKEN.secret);

  expect(ctx.calls).toEqual([
    'system/info',
    'tokens/create',
    'system/info',
    'secrets/add',
    'secrets/add',
  ]);
});

// features that are false, a missing features object and a failed check all
// stop the write
test.each([
  [
    'false flags',
    {
      ...NEW_INFO,
      features: { ...NEW_INFO.features, grantableTokens: false, secretRebind: false },
    },
  ],
  ['no features object', { version: '0.14.0' }],
  ['a failed check', 'fail'],
])('%s: no token create and no secret replace', async (_name, info) => {
  await using ctx = setupTest(info);

  const token = await ctx.run([...GRANTER, '--grantable', 'gh']);
  const replace = await ctx.run(['secret', 'add', 'gh', '--kind', 'github', '--replace'], 'v\n');

  expect([token.code, replace.code]).toEqual([1, 1]);
  expect(ctx.calls).toEqual(['system/info', 'system/info']);
});

test('exec --require on an older impd runs nothing, and a bad list makes no call', async () => {
  await using ctx = setupTest({ ...NEW_INFO, version: '0.29.0' });

  const older = await ctx.run(['exec', 'box', '--require', 'broker', '--', 'true']);

  expect(older.code).toBe(1);
  expect(older.stderr).toContain('this impd is older than 0.30.0');
  expect(ctx.calls).toEqual(['system/info']);

  const unknown = await ctx.run(['exec', 'box', '--require', 'network', '--', 'true']);
  const agent = await ctx.run(['exec', 'box', '--agent', '--require', 'broker', '--', 'true']);

  expect([unknown.code, agent.code]).toEqual([2, 2]);
  expect(unknown.stderr).toContain('--require takes broker; not network');
  expect(agent.stderr).toContain('--require does not go with --agent');
  expect(ctx.calls).toEqual(['system/info']);
});
