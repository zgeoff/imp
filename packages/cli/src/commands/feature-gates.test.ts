import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `token new --grantable` and `secret add --replace` rely on fields an older
// impd drops unread, so the CLI checks impd's features before it writes.

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

// An impd that answers system.info with or without the new features, and
// records every call
function startImpd(hasFeatures: boolean) {
  const calls: string[] = [];

  const features = hasFeatures
    ? { sessionOffsets: true, leases: true, grantableTokens: true, secretRebind: true }
    : { sessionOffsets: true, leases: true };

  const answers: Readonly<Record<string, unknown>> = {
    'system/info': { version: hasFeatures ? '0.27.0' : '0.26.0', features },
    'tokens/create': MADE_TOKEN,
    'secrets/add': SECRET,
  };

  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname.replace(/^\/rpc\//u, '');

      calls.push(path);

      return Response.json({ json: answers[path] ?? null });
    },
  });

  return { url: `http://localhost:${String(server.port)}`, server, calls };
}

function setupTest(hasFeatures: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-feature-gates-'));
  const impd = startImpd(hasFeatures);

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
  await using ctx = setupTest(true);

  const results = await Promise.all([
    ctx.run(['token', 'new', 'agent', '--scope', 'manage', '--grantable', 'gh']),
    ctx.run(['token', 'new', 'agent', '--scope', 'exec', '--imps', 'agent-*', '--grantable', 'gh']),
    ctx.run([...GRANTER, '--grantable', 'Not A Name']),
    ctx.run(['secret', 'add', 'gh', '--kind', 'github', '--rebind'], 'ghp_value\n'),
  ]);

  expect(results.map((result) => result.code)).toEqual([2, 2, 2, 2]);
  expect(results[0]?.stderr).toContain('--grantable needs --scope manage and --imps');
  expect(results[2]?.stderr).toContain('--grantable takes secret names');
  expect(results[3]?.stderr).toContain('--rebind needs --replace');
  expect(ctx.calls).toEqual([]);
});

test('an older impd gets no token create and no secret replace, only the feature check', async () => {
  await using ctx = setupTest(false);

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
  await using ctx = setupTest(true);

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
