import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';

// `token new --grantable`, `secret add --replace` and `exec --require` rely
// on fields an older impd drops unread, and `db copy` on a call it lacks, so
// the CLI checks impd's features before it writes or runs anything.

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
  features: {
    sessionOffsets: true,
    leases: true,
    grantableTokens: true,
    secretRebind: true,
    secretFilesGc: true,
    tokenUpdate: true,
  },
};

const OLD_INFO = { version: '0.26.0', features: { sessionOffsets: true, leases: true } };

// An impd that answers system.info with `info`, or fails it when `info` is
// 'fail', and records every call
function startImpd(info: unknown, extra: Readonly<Record<string, unknown>> = {}) {
  const calls: string[] = [];

  const datePaths: Readonly<Record<string, readonly (readonly string[])[]>> = {
    'secrets/add': [['createdAt'], ['oauth', 'expiresAt']],
    'secrets/refresh': [['createdAt'], ['oauth', 'expiresAt']],
  };

  const answers: Readonly<Record<string, unknown>> = {
    'system/info': info,
    'tokens/create': MADE_TOKEN,
    'tokens/update': MADE_TOKEN.token,
    'secrets/add': SECRET,
    ...extra,
    'system/copyDatabase': {
      path: '/var/lib/imp/db-copies/before-upgrade.sqlite',
      sizeBytes: 4096,
      lastMigration: '030_x',
      impVersion: '0.30.0',
      createdAt: '2026-10-04T00:00:00.000Z',
      integrity: 'ok',
    },
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

      // a date travels as an ISO string with a note of its path, as impd sends it
      const dates = (datePaths[path] ?? []).filter((segments) =>
        hasString(answers[path], segments),
      );

      return Response.json({
        json: answers[path] ?? null,
        meta: dates.map((segments) => buildDateMeta(segments)),
      });
    },
  });

  return { url: `http://localhost:${String(server.port)}`, server, calls };
}

function buildDateMeta(segments: readonly string[]): (number | string)[] {
  return [1, ...segments];
}

// whether the answer holds a string at the path
function hasString(answer: unknown, segments: readonly string[]): boolean {
  const found = segments.reduce<unknown>(
    (node, key) => (typeof node === 'object' && node !== null ? Reflect.get(node, key) : null),
    answer,
  );

  return typeof found === 'string';
}

function setupTest(info: unknown, extra: Readonly<Record<string, unknown>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-feature-gates-'));
  const impd = startImpd(info, extra);

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

test('db copy asks for the feature first: an older impd gets no copy call', async () => {
  const outcomes: { code: number; calls: string[] }[] = [];

  for (const info of [
    OLD_INFO,
    { ...NEW_INFO, features: { ...NEW_INFO.features, databaseCopy: true } },
  ]) {
    await using ctx = setupTest(info);

    const result = await ctx.run(['db', 'copy', 'before-upgrade', '--json']);

    outcomes.push({ code: result.code, calls: [...ctx.calls] });

    if (info === OLD_INFO) {
      expect(result.stderr).toContain('this impd is older than 0.30.0');
    } else {
      // a restore script matches these names, in this order
      const printed: unknown = JSON.parse(result.stdout);
      const fields = Object.keys(z.record(z.string(), z.unknown()).parse(printed));

      expect(fields).toEqual([
        'path',
        'sizeBytes',
        'lastMigration',
        'impVersion',
        'createdAt',
        'integrity',
      ]);
    }
  }

  expect(outcomes).toEqual([
    { code: 1, calls: ['system/info'] },
    { code: 0, calls: ['system/info', 'system/copyDatabase'] },
  ]);
});

test('an older impd gets no console --log, only the feature check', async () => {
  await using ctx = setupTest(OLD_INFO);

  const result = await ctx.run(['console', 'dev', '--session', 'main', '--log']);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('this impd has no session logs');
  expect(ctx.calls).toEqual(['system/info']);
});

test('console --log without a session is a usage error', async () => {
  await using ctx = setupTest(NEW_INFO);

  const result = await ctx.run(['console', 'dev', '--no-session', '--log']);

  expect(result.code).toBe(2);
  expect(result.stderr).toContain('--log needs a session');
  expect(ctx.calls).toEqual([]);
});

test('token set checks for tokens.update first, and refuses a bad name before any call', async () => {
  await using older = setupTest(OLD_INFO);
  await using newer = setupTest(NEW_INFO);

  const refused = await older.run(['token', 'set', 'agent', '--grantable', 'gh']);
  const badName = await newer.run(['token', 'set', 'agent', '--grantable', 'Not A Name']);
  const set = await newer.run(['token', 'set', 'agent', '--grantable', 'gh', '--json']);

  // '' clears the list; --json, as this fake impd sends dates as strings
  const cleared = await newer.run(['token', 'set', 'agent', '--grantable', '', '--json']);

  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('this impd is older than 0.34.0');
  expect(refused.stderr).toContain('nothing was changed');
  expect(older.calls).toEqual(['system/info']);
  expect(badName.code).toBe(2);
  expect(badName.stderr).toContain('--grantable takes secret names');
  expect([set.code, cleared.code]).toEqual([0, 0]);
  expect(z.object({ name: z.string() }).parse(JSON.parse(set.stdout))).toEqual({ name: 'agent' });
  expect(newer.calls).toEqual(['system/info', 'tokens/update', 'system/info', 'tokens/update']);
});

const OAUTH_ARGS = [
  'secret',
  'add',
  'codex',
  '--kind',
  'oauth',
  '--hosts',
  'chatgpt.com',
  '--token-url',
  'https://auth.example.com/oauth/token',
  '--client-id',
  'fake-client',
  '--token-format',
  'json',
];

function buildOAuthSecret(status: string, error: string | null) {
  return {
    ...SECRET,
    name: 'codex',
    kind: 'oauth',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
      status,
      expiresAt: status === 'ready' ? '2030-01-01T00:00:00.000Z' : null,
      refreshedAt: null,
      error,
      idClaims: null,
    },
  };
}

test('an oauth secret needs an impd that has them, and says how its sign-in went', async () => {
  await using older = setupTest(OLD_INFO);

  const refused = await older.run(OAUTH_ARGS, 'fake-refresh\n');

  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('this impd has no oauth secrets');
  expect(older.calls).toEqual(['system/info']);

  const features = { ...NEW_INFO.features, oauthSecrets: true };

  await using ready = setupTest(
    { ...NEW_INFO, features },
    { 'secrets/add': buildOAuthSecret('ready', null) },
  );

  const added = await ready.run(OAUTH_ARGS, 'fake-refresh\n');

  expect(added.code).toBe(0);

  expect(added.stderr).toContain(
    'imp: codex signed in, access token valid until 2030-01-01T00:00:00.000Z',
  );

  expect(added.stdout).toContain('ready until 2030-01-01T00:00:00.000Z');
  expect(ready.calls).toEqual(['system/info', 'secrets/add']);

  await using dead = setupTest(
    { ...NEW_INFO, features },
    { 'secrets/add': buildOAuthSecret('needs_login', 'invalid_grant') },
  );

  const failed = await dead.run(OAUTH_ARGS, 'fake-refresh\n');

  expect(failed.stderr).toContain('imp: codex is needs_login: invalid_grant');
  expect(failed.stdout).toContain('needs_login (invalid_grant)');

  expect(`${added.stdout}${added.stderr}${failed.stdout}${failed.stderr}`).not.toContain(
    'fake-refresh',
  );
});

test('secret refresh prints the secret and exits 1 unless it is ready', async () => {
  const features = { ...NEW_INFO.features, oauthSecrets: true };

  await using ready = setupTest(
    { ...NEW_INFO, features },
    { 'secrets/refresh': buildOAuthSecret('ready', null) },
  );

  const good = await ready.run(['secret', 'refresh', 'codex']);

  expect(good.code).toBe(0);
  expect(good.stdout).toContain('ready until');

  await using pending = setupTest(
    { ...NEW_INFO, features },
    { 'secrets/refresh': buildOAuthSecret('pending', 'HTTP 503') },
  );

  const bad = await pending.run(['secret', 'refresh', 'codex', '--json']);

  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain('codex is pending: HTTP 503');
  expect(JSON.parse(bad.stdout)).toMatchObject({ oauth: { status: 'pending' } });

  await using older = setupTest(OLD_INFO);

  const refused = await older.run(['secret', 'refresh', 'codex']);

  expect(refused.code).toBe(1);
  expect(older.calls).toEqual(['system/info']);
});

test('secret ls shows a state column, and a dash for other kinds', async () => {
  await using ctx = setupTest(NEW_INFO, {
    'secrets/list': [SECRET, buildOAuthSecret('needs_login', 'refresh_token_reused')],
  });

  const listed = await ctx.run(['secret', 'ls']);

  expect(listed.stdout).toContain('STATE');
  expect(listed.stdout).toContain('needs_login (refresh_token_reused)');
  expect(listed.stdout.split('\n')[1]).toMatch(/^gh\s+github\s+-\s/);
});

const UPSTREAM_ARGS = [
  'secret',
  'add',
  'op-connect',
  '--kind',
  'custom',
  '--hosts',
  'op-connect.imp.internal',
  '--upstream',
  'http://172.17.0.1:18081',
];

test('a secret upstream needs an impd that knows it, and sends it in the rule', async () => {
  await using older = setupTest(OLD_INFO);

  const refused = await older.run(UPSTREAM_ARGS, 'fake-token\n');

  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('this impd has no secret upstreams');
  expect(older.calls).toEqual(['system/info']);

  const features = { ...NEW_INFO.features, secretUpstream: true };

  await using ready = setupTest({ ...NEW_INFO, features });

  const added = await ready.run(UPSTREAM_ARGS, 'fake-token\n');

  expect(added.code).toBe(0);
  expect(ready.calls).toEqual(['system/info', 'secrets/add']);
});

test('--upstream is refused before any call unless it is one host of kind custom', async () => {
  await using impd = setupTest(NEW_INFO);

  const twoHosts = await impd.run(
    UPSTREAM_ARGS.map((arg) =>
      arg === 'op-connect.imp.internal' ? 'a.example.com,b.example.com' : arg,
    ),
    'fake-token\n',
  );

  expect(twoHosts.code).toBe(2);
  expect(twoHosts.stderr).toContain('--upstream needs exactly one host');

  const preset = await impd.run(
    ['secret', 'add', 'gh', '--kind', 'github', '--upstream', 'http://172.17.0.1:18081'],
    'fake-token\n',
  );

  expect(preset.code).toBe(2);
  expect(preset.stderr).toContain('--upstream is for --kind custom');

  const path = await impd.run(
    UPSTREAM_ARGS.map((arg) =>
      arg === 'http://172.17.0.1:18081' ? 'http://172.17.0.1:18081/x' : arg,
    ),
    'fake-token\n',
  );

  expect(path.code).toBe(2);
  expect(path.stderr).toContain('must be an origin with no path');
  expect(impd.calls).toEqual([]);
});
