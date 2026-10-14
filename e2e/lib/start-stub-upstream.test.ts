import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitCommand } from './git-env';
import { startStubUpstream } from './start-stub-upstream';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-upstream-test-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // a commit to push, made the way a user's checkout would hold one
  const work = join(dir, 'work');

  const gitEnv = {
    GIT_AUTHOR_NAME: 'e2e',
    GIT_AUTHOR_EMAIL: 'e2e@imp.test',
    GIT_COMMITTER_NAME: 'e2e',
    GIT_COMMITTER_EMAIL: 'e2e@imp.test',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };

  await runGitCommand(['git', 'init', '-q', '-b', 'main', work], { env: gitEnv });
  await writeFile(join(work, 'README'), 'pushed\n');
  await runGitCommand(['git', '-C', work, 'add', 'README'], { env: gitEnv });
  await runGitCommand(['git', '-C', work, 'commit', '-q', '-m', 'first'], { env: gitEnv });

  const head = await runGitCommand(['git', '-C', work, 'rev-parse', 'main'], { env: gitEnv });

  return { dir, work, gitEnv, head: head.stdout.trim() };
}

test('it serves https that verifies against its own CA', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  const response = await fetch(`${upstream.origin}/user`, {
    headers: { authorization: 'Bearer token-a' },
    tls: { ca: upstream.caPem },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ authorized: true });
});

test('it fails certificate verification for a client without its CA', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  expect(
    fetch(`${upstream.origin}/user`, { headers: { authorization: 'Bearer token-a' } }),
  ).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
});

test('it reports a bearer token other than its own as unauthorized', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  const response = await fetch(`${upstream.origin}/user`, {
    headers: { authorization: 'Bearer token-b' },
    tls: { ca: upstream.caPem },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ authorized: false });
});

test('it serves the same answers over plain http', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  const response = await fetch(`${upstream.plainOrigin}/user`, {
    headers: { authorization: 'Bearer token-a' },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ authorized: true });
});

test('it records each request it sees with its authorization header', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  await fetch(`${upstream.plainOrigin}/repos/acme/repo`, {
    headers: { authorization: 'Bearer token-a' },
  });

  expect(upstream.seen).toStrictEqual([
    { method: 'GET', path: '/repos/acme/repo', authorization: 'Bearer token-a' },
  ]);
});

test('it lands a git push over smart http with its Basic credential', async () => {
  const ctx = await setupTest();
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  const repo = await upstream.createRepo('acme/repo.git');

  const caFile = join(ctx.dir, 'ca.pem');

  await writeFile(caFile, upstream.caPem);

  const url = new URL(`${upstream.origin}/acme/repo.git`);

  url.username = 'x-access-token';
  url.password = 'token-a';

  const push = await runGitCommand(['git', '-C', ctx.work, 'push', '-q', url.href, 'main'], {
    env: { ...ctx.gitEnv, GIT_SSL_CAINFO: caFile },
  });

  const landed = await runGitCommand(['git', '-C', repo, 'rev-parse', 'main']);

  expect(push.exitCode).toBe(0);
  expect(landed.stdout.trim()).toBe(ctx.head);
});

test('it refuses a git push with another Basic credential', async () => {
  const ctx = await setupTest();
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  const repo = await upstream.createRepo('acme/repo.git');

  const caFile = join(ctx.dir, 'ca.pem');

  await writeFile(caFile, upstream.caPem);

  const url = new URL(`${upstream.origin}/acme/repo.git`);

  url.username = 'x-access-token';
  url.password = 'token-b';

  const push = await runGitCommand(['git', '-C', ctx.work, 'push', '-q', url.href, 'main'], {
    env: { ...ctx.gitEnv, GIT_SSL_CAINFO: caFile },
  });

  const landed = await runGitCommand([
    'git',
    '-C',
    repo,
    'rev-parse',
    '--verify',
    '--quiet',
    'main',
  ]);

  expect(push.exitCode).toBe(128);
  expect(push.stderr).toInclude('Authentication failed');
  expect(landed.exitCode).toBe(1);
});

test('it exchanges the current refresh token for a new access and refresh token', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  const response = await fetch(`${upstream.origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: upstream.oauth.clientId,
      refresh_token: upstream.oauth.firstRefreshToken,
    }),
    tls: { ca: upstream.caPem },
  });

  expect(response.status).toBe(200);

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    access_token: expect.toStartWith('e2e-access-'),
    refresh_token: expect.toStartWith('e2e-refresh-'),
    expires_in: 3600,
  });
});

test('it refuses a refresh token that an exchange already rotated out', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  upstream.oauth.exchange(upstream.oauth.firstRefreshToken);

  const response = await fetch(`${upstream.origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: upstream.oauth.clientId,
      refresh_token: upstream.oauth.firstRefreshToken,
    }),
    tls: { ca: upstream.caPem },
  });

  expect(response.status).toBe(400);

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ error: 'invalid_grant' });
  expect(upstream.oauth.refused()).toBe(1);
});

test('it rejects a token request from another client id', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  const response = await fetch(`${upstream.origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'another-client',
      refresh_token: upstream.oauth.firstRefreshToken,
    }),
    tls: { ca: upstream.caPem },
  });

  expect(response.status).toBe(400);

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ error: 'invalid_request' });
});

test('it authorizes the newest access token it issued', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  upstream.oauth.exchange(upstream.oauth.firstRefreshToken);

  const response = await fetch(`${upstream.origin}/oauth-e2e/me`, {
    headers: { authorization: `Bearer ${upstream.oauth.accessTokens().at(-1) ?? ''}` },
    tls: { ca: upstream.caPem },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ generation: 1, authorized: true });
});

test('it reports an access token that a later exchange replaced as unauthorized', async () => {
  const upstream = await startStubUpstream('127.0.0.1', 'token-a');

  onTestFinished(() => upstream.stop());

  upstream.oauth.exchange(upstream.oauth.firstRefreshToken);
  upstream.oauth.exchange(upstream.oauth.refreshTokens().at(-1) ?? '');

  const response = await fetch(`${upstream.origin}/oauth-e2e/me`, {
    headers: { authorization: `Bearer ${upstream.oauth.accessTokens()[0] ?? ''}` },
    tls: { ca: upstream.caPem },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ generation: 2, authorized: false });
});
