import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostConfig, resolveConfigPath, writeHostConfig } from '../host-store';

const MAIN = join(import.meta.dir, '..', 'main.ts');
const TOKEN = 'login-secret-token';

// An impd that answers system.info for the right token and 401 otherwise,
// and records the tokens it saw.
function startImpd() {
  const seen: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push(request.headers.get('authorization') ?? '');

      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json({ json: { message: 'unauthorized' } }, { status: 401 });
      }

      return Response.json({ json: [] });
    },
  });

  return { url: `http://localhost:${String(server.port)}`, seen, server };
}

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-login-'));
  const impd = startImpd();
  const env = { XDG_CONFIG_HOME: dir };

  return {
    env,
    impd,

    // runs the CLI as a user would, with `stdin` piped in
    run: async (
      args: readonly string[],
      stdin = '',
      extraEnv: Readonly<Record<string, string>> = {},
    ) => {
      const child = Bun.spawn(['bun', MAIN, ...args], {
        env: { PATH: process.env['PATH'] ?? '', HOME: dir, ...env, ...extraEnv },
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
    },
    [Symbol.asyncDispose]: async () => {
      await impd.server.stop(true);

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('login checks the token, saves the host as current, and never prints the token', async () => {
  await using ctx = setupTest();

  const login = await ctx.run(['login', ctx.impd.url, '--name', 'home'], `${TOKEN}\n`);

  expect(login).toEqual({
    stdout: `logged in to ${ctx.impd.url} as home, now the current host\n`,
    stderr: '',
    code: 0,
  });

  expect(ctx.impd.seen).toEqual([`Bearer ${TOKEN}`]);

  expect(readHostConfig(ctx.env)).toEqual({
    current: 'home',
    hosts: { home: { url: ctx.impd.url, token: TOKEN } },
  });

  const ls = await ctx.run(['hosts']);

  expect(ls.stdout).toBe(
    `   NAME  URL${' '.repeat(ctx.impd.url.length - 3)}  TOKEN\n*  home  ${ctx.impd.url}  saved\n`,
  );

  expect(ls.stdout + ls.stderr).not.toContain(TOKEN);
});

test('a refused token, an empty token or an unreachable impd saves nothing', async () => {
  await using ctx = setupTest();

  const refused = await ctx.run(['login', ctx.impd.url], 'wrong\n');
  const empty = await ctx.run(['login', ctx.impd.url], '\n');
  const unreachable = await ctx.run(['login', 'http://127.0.0.1:1'], `${TOKEN}\n`);

  expect(refused).toEqual({
    stdout: '',
    stderr: `imp: ${ctx.impd.url} refused the token; nothing saved\n`,
    code: 1,
  });

  expect(empty).toMatchObject({ stderr: 'imp: no token given; nothing saved\n', code: 2 });
  expect(unreachable.stderr).toStartWith('imp: cannot check the token with http://127.0.0.1:1: ');
  expect(unreachable.stderr).toEndWith('; nothing saved\n');
  expect(unreachable.code).toBe(1);
  expect(readHostConfig(ctx.env)).toEqual({ current: null, hosts: {} });
});

test('--no-verify saves without asking impd, and plain http to another machine warns', async () => {
  await using ctx = setupTest();

  const login = await ctx.run(['login', 'http://imp.example:7070', '--no-verify'], 'tok\n');

  expect(login).toEqual({
    stdout: 'logged in to http://imp.example:7070 as imp, now the current host\n',
    stderr:
      'imp: warning: http://imp.example:7070 is plain http; the token crosses the network unencrypted\n',
    code: 0,
  });

  expect(ctx.impd.seen).toEqual([]);
});

test('login on a damaged config.json fails and leaves the file as it was', async () => {
  await using ctx = setupTest();

  writeHostConfig(ctx.env, { current: null, hosts: {} });
  writeFileSync(resolveConfigPath(ctx.env), '{ damaged', { mode: 0o600 });

  const login = await ctx.run(['login', ctx.impd.url], `${TOKEN}\n`);

  expect(login.code).toBe(2);
  expect(login.stderr).toContain('is not valid JSON; fix or remove it');
  expect(readFileSync(resolveConfigPath(ctx.env), 'utf8')).toBe('{ damaged');
  expect(ctx.impd.seen).toEqual([]);
});

test('host use and rm switch and forget hosts', async () => {
  await using ctx = setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: {
      home: { url: 'https://home.example', token: 'a' },
      work: { url: ctx.impd.url, token: 'b' },
    },
  });

  const use = await ctx.run(['host', 'use', 'work']);

  expect(use).toMatchObject({ code: 0 });
  expect(readHostConfig(ctx.env).current).toBe('work');

  const useUnknown = await ctx.run(['host', 'use', 'nope']);

  expect(useUnknown).toEqual({
    stdout: '',
    stderr: 'imp: no saved host nope (see imp host ls)\n',
    code: 2,
  });

  const rm = await ctx.run(['host', 'rm', 'work']);

  expect(rm).toMatchObject({ code: 0 });

  expect(readHostConfig(ctx.env)).toEqual({
    current: null,
    hosts: { home: { url: 'https://home.example', token: 'a' } },
  });
});

test('--host picks a saved host, and a 401 names it', async () => {
  await using ctx = setupTest();

  writeHostConfig(ctx.env, {
    current: null,
    hosts: { work: { url: ctx.impd.url, token: 'stale' } },
  });

  const result = await ctx.run(['--host', 'work', 'ls'], '', { IMP_TOKEN: 'ignored' });

  expect(ctx.impd.seen).toEqual(['Bearer stale']);

  expect(result).toEqual({
    stdout: '',
    stderr: `imp: unauthorized: work (${ctx.impd.url}) refused the token; run imp login ${ctx.impd.url} --name work\n`,
    code: 1,
  });

  const noName = await ctx.run(['ls', '--host']);

  expect(noName).toEqual({
    stdout: '',
    stderr: 'imp: --host needs a saved host name (see imp host ls)\n',
    code: 2,
  });
});
