import { expect, test } from 'bun:test';
import { createSecret, findSecret, removeSecret } from '../db/secrets';
import { setupImpTest } from '../imps/test-imps';
import { createOAuthRefresher, isDue } from './oauth-refresher';
import type { OAuthRequest } from './oauth-refresher';
import { buildPendingState, formatOAuthState, parseOAuthState } from './oauth-state';
import type { OAuthStateFile } from './oauth-state';
import { buildValueFile, createSecretFiles } from './secret-files';

// Every token here is made up, and the token endpoint is a function.

const HOUR = 3_600_000;
const T0 = Date.parse('2030-01-01T00:00:00Z');
const RULES = [{ host: 'api.example.com', header: 'authorization', scheme: 'bearer' as const }];

interface Call {
  readonly url: string;
  readonly contentType: string | null;
  readonly accept: string | null;
  readonly body: string;
  readonly redirect: string;
}

type Reply = () => Response | Promise<Response>;

function buildReply(status: number, body: unknown): Reply {
  return () => Response.json(body, { status });
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function buildJwt(claims: Readonly<Record<string, unknown>>): string {
  return `${encodeSegment({ alg: 'none' })}.${encodeSegment(claims)}.fake`;
}

function buildReadyState(overrides: Partial<OAuthStateFile> = {}): OAuthStateFile {
  return {
    v: 1,
    refreshToken: 'fake-refresh-0',
    accessToken: 'fake-access-0',
    idToken: 'fake-id-0',
    expiresAt: T0 + 240 * HOUR,
    refreshedAt: T0,
    status: 'ready',
    error: null,
    ...overrides,
  };
}

async function setupTest(options: { readonly format?: 'json' | 'form' } = {}) {
  const harness = await setupImpTest();

  const files = createSecretFiles(harness.dataDir);
  const logs: string[] = [];
  const calls: Call[] = [];
  const replies: Reply[] = [];
  const clock = { now: T0 };
  const hold = { gate: null as Promise<void> | null };

  const refresher = createOAuthRefresher({
    db: harness.db,
    files,
    log: (message) => {
      logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => clock.now,
    fetch: async (url: string, init: OAuthRequest) => {
      calls.push({
        url,
        contentType: init.headers.get('content-type'),
        accept: init.headers.get('accept'),
        body: init.body,
        redirect: init.redirect,
      });

      if (hold.gate !== null) {
        await hold.gate;
      }

      const next = replies.shift();

      if (next === undefined) {
        throw new Error('no reply queued');
      }

      return next();
    },
  });

  const writeState = async (state: OAuthStateFile, name = 'codex') => {
    const valueFile = buildValueFile(name);

    files.write(valueFile, formatOAuthState(state));

    await createSecret(harness.db, {
      name,
      kind: 'oauth',
      rules: RULES,
      oauth: {
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'fake-client',
        tokenFormat: options.format ?? 'form',
      },
      valueFile,
    });

    return valueFile;
  };

  const readState = async (name = 'codex'): Promise<OAuthStateFile | null> => {
    const secret = await findSecret(harness.db, name);

    const text = secret === undefined ? null : files.read(secret.valueFile);

    return text === null ? null : parseOAuthState(text);
  };

  return {
    ...harness,
    files,
    logs,
    calls,
    replies,
    clock,
    hold,
    refresher,
    writeState,
    readState,
  };
}

// no log line, state or error of the refresher may carry a token
function assertNoTokens(logs: readonly string[]): void {
  expect(logs.join('\n')).not.toMatch(/fake-(?:access|refresh|id)/);
}

test('a refresh sends the form, stores the rotated tokens and logs no token', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  ctx.replies.push(
    buildReply(200, {
      access_token: 'fake-access-1',
      refresh_token: 'fake-refresh-1',
      id_token: 'fake-id-1',
      expires_in: 7200,
    }),
  );

  const outcome = await ctx.refresher.refresh('codex', true);

  expect(outcome).toEqual({ kind: 'refreshed', rotated: true });

  expect(ctx.calls).toEqual([
    {
      url: 'https://auth.example.com/oauth/token',
      contentType: 'application/x-www-form-urlencoded',
      accept: 'application/json',
      body: 'grant_type=refresh_token&refresh_token=fake-refresh-0&client_id=fake-client',
      redirect: 'manual',
    },
  ]);

  const state = await ctx.readState();

  expect(state).toEqual({
    v: 1,
    refreshToken: 'fake-refresh-1',
    accessToken: 'fake-access-1',
    idToken: 'fake-id-1',
    expiresAt: T0 + 2 * HOUR,
    refreshedAt: T0,
    status: 'ready',
    error: null,
  });

  expect(ctx.logs).toEqual([
    'impd: broker: oauth secret codex refreshed; refresh token rotated: yes; expires 2030-01-01T02:00:00.000Z',
  ]);

  assertNoTokens(ctx.logs);
});

test('the json format sends a json body', async () => {
  await using ctx = await setupTest({ format: 'json' });

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1', expires_in: 60 }));

  await ctx.refresher.refresh('codex', true);

  expect(ctx.calls[0]?.contentType).toBe('application/json');

  expect(JSON.parse(ctx.calls[0]?.body ?? '')).toEqual({
    grant_type: 'refresh_token',
    refresh_token: 'fake-refresh-0',
    client_id: 'fake-client',
  });
});

test('a field the answer leaves out keeps its old value, and an unrotated refresh token is logged as such', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildReadyState());

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1', expires_in: 3600 }));

  const outcome = await ctx.refresher.refresh('codex', true);

  expect(outcome).toEqual({ kind: 'refreshed', rotated: false });

  const state = await ctx.readState();

  expect(state).toMatchObject({
    refreshToken: 'fake-refresh-0',
    accessToken: 'fake-access-1',
    idToken: 'fake-id-0',
  });

  expect(ctx.logs[0]).toContain('refresh token rotated: no');

  // an answer with only a new refresh token keeps the access token
  ctx.replies.push(buildReply(200, { refresh_token: 'fake-refresh-2' }));

  await ctx.refresher.refresh('codex', true);

  const state2 = await ctx.readState();

  expect(state2).toMatchObject({
    refreshToken: 'fake-refresh-2',
    accessToken: 'fake-access-1',
  });

  assertNoTokens(ctx.logs);
});

test('the expiry is expires_in, else the access token exp, else unknown', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  const exp = Math.floor((T0 + 10 * HOUR) / 1000);

  ctx.replies.push(
    buildReply(200, { access_token: buildJwt({ exp }), expires_in: 3600 }),
    buildReply(200, { access_token: buildJwt({ exp }) }),
    buildReply(200, { access_token: 'fake-access-opaque' }),
  );

  await ctx.refresher.refresh('codex', true);

  const expiry1 = await ctx.readState();

  expect(expiry1?.expiresAt).toBe(T0 + HOUR);

  await ctx.refresher.refresh('codex', true);

  const expiry2 = await ctx.readState();

  expect(expiry2?.expiresAt).toBe(T0 + 10 * HOUR);

  await ctx.refresher.refresh('codex', true);

  const expiry3 = await ctx.readState();

  expect(expiry3?.expiresAt).toBeNull();
});

test('an expiry no date can hold is unknown, and the rotated tokens are kept', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  ctx.replies.push(
    buildReply(200, {
      access_token: 'fake-access-1',
      refresh_token: 'fake-refresh-1',
      expires_in: 1e20,
    }),
  );

  await ctx.refresher.refresh('codex', true);

  const state = await ctx.readState();

  expect(state?.status).toBe('ready');
  expect(state?.expiresAt).toBeNull();
  expect(state?.refreshToken).toBe('fake-refresh-1');
  expect(state?.accessToken).toBe('fake-access-1');
});

test('an expires_in of 0 is due now, not unknown', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1', expires_in: 0 }));

  await ctx.refresher.refresh('codex', true);

  const state = await ctx.readState();

  expect(state?.expiresAt).toBe(T0);
});

test('a 200 with no token is a transient failure that changes nothing', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildReadyState());

  const before = await ctx.readState();

  ctx.replies.push(buildReply(200, {}));

  await ctx.refresher.refresh('codex', true);

  const after = await ctx.readState();

  expect(after?.status).toBe('ready');
  expect(after?.refreshedAt).toBe(before?.refreshedAt ?? -1);
  expect(after?.accessToken).toBe(before?.accessToken ?? '');
  expect(after?.error).toBe('no token in the response');
});

test('when a refresh is due', () => {
  const ready = buildReadyState();

  // a 240 h token is refreshed with 24 h left
  expect(isDue(ready, T0 + 215 * HOUR)).toBe(false);
  expect(isDue(ready, T0 + 217 * HOUR)).toBe(true);

  // a short one at half its lifetime
  const short = buildReadyState({ expiresAt: T0 + 2 * HOUR });

  expect(isDue(short, T0 + 0.9 * HOUR)).toBe(false);
  expect(isDue(short, T0 + 1.1 * HOUR)).toBe(true);

  // no expiry: older than an hour
  const unknown = buildReadyState({ expiresAt: null });

  expect(isDue(unknown, T0 + 0.9 * HOUR)).toBe(false);
  expect(isDue(unknown, T0 + 1.1 * HOUR)).toBe(true);

  // nothing to send yet
  expect(isDue(buildPendingState('fake-refresh-0'), T0)).toBe(true);
  expect(isDue(buildReadyState({ accessToken: null }), T0)).toBe(true);

  // a dead refresh token is never tried again by the timer
  expect(isDue(buildReadyState({ status: 'needs_login' }), T0 + 1000 * HOUR)).toBe(false);
});

test('the timer refreshes a secret that is due and leaves the others', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildReadyState(), 'codex');
  await ctx.writeState(buildReadyState({ refreshToken: 'fake-refresh-b' }), 'other');

  ctx.clock.now = T0 + 230 * HOUR;

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1', expires_in: 3600 }));

  await ctx.refresher.tick();

  expect(ctx.calls).toHaveLength(2);

  // a second check finds both fresh
  await ctx.refresher.tick();

  expect(ctx.calls).toHaveLength(2);
});

test('a transient error keeps the tokens and the status, and backs off 1, 2, 4 minutes up to 30', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildReadyState());

  ctx.clock.now = T0 + 230 * HOUR;

  const writeFailure = async (): Promise<void> => {
    ctx.replies.push(buildReply(503, { error: 'server_error', detail: 'fake-refresh-0' }));

    await ctx.refresher.tick();
  };

  await writeFailure();

  expect(ctx.calls).toHaveLength(1);

  const state = await ctx.readState();

  expect(state).toMatchObject({
    status: 'ready',
    error: 'HTTP 503',
    refreshToken: 'fake-refresh-0',
    accessToken: 'fake-access-0',
  });

  // inside the first minute: no call
  ctx.clock.now += 59_000;

  await ctx.refresher.tick();

  expect(ctx.calls).toHaveLength(1);

  // after it, a call that fails again waits two minutes
  ctx.clock.now += 2000;

  await writeFailure();

  expect(ctx.calls).toHaveLength(2);

  ctx.clock.now += 119_000;

  await ctx.refresher.tick();

  expect(ctx.calls).toHaveLength(2);

  ctx.clock.now += 2000;

  await writeFailure();

  expect(ctx.calls).toHaveLength(3);

  // the wait doubles up to 30 minutes
  for (let index = 0; index < 8; index += 1) {
    ctx.clock.now += 31 * 60_000;

    await writeFailure();
  }

  expect(ctx.logs.at(-1)).toContain('trying again in 30 min');

  // a success clears it
  ctx.clock.now += 31 * 60_000;

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1', expires_in: 7200 }));

  await ctx.refresher.tick();

  const state2 = await ctx.readState();

  expect(state2).toMatchObject({ status: 'ready', error: null });

  assertNoTokens(ctx.logs);
});

test('an error on a pending secret leaves it pending', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  ctx.replies.push(() => {
    throw new Error('connect ECONNREFUSED');
  });

  const outcome = await ctx.refresher.refresh('codex', true);

  expect(outcome).toEqual({ kind: 'transient', error: 'network error' });

  const state = await ctx.readState();

  expect(state).toMatchObject({ status: 'pending', error: 'network error' });
});

test('a redirect, an unparseable answer and an answer without a usable token are transient', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildReadyState());

  const answers: readonly [Reply, string][] = [
    [
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } }),
      'HTTP 302',
    ],
    [() => new Response('<html>nope</html>'), 'invalid response'],
    [buildReply(200, { access_token: 'has space' }), 'invalid response'],
    [buildReply(200, { access_token: 'bad\r\nx-evil: 1' }), 'invalid response'],
  ];

  for (const [answer, error] of answers) {
    ctx.replies.push(answer);

    const outcome = await ctx.refresher.refresh('codex', true);

    expect(outcome).toEqual({ kind: 'transient', error });
  }

  // the old tokens are still the live ones
  const state = await ctx.readState();

  expect(state).toMatchObject({
    refreshToken: 'fake-refresh-0',
    accessToken: 'fake-access-0',
  });
});

test('a call that outlasts the timeout is transient', async () => {
  await using ctx = await setupTest();

  const timed = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const reason: unknown = init.signal.reason;
          const failure = reason instanceof Error ? reason : new Error('aborted');

          reject(failure);
        });
      }),
  });

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  const outcome = await timed.refresh('codex', true);

  expect(outcome).toEqual({ kind: 'transient', error: 'timeout' });
});

test('each permanent error shape needs a new sign-in, once, and the timer stops', async () => {
  const permanent: readonly [Reply, string][] = [
    [buildReply(401, { message: 'no' }), 'HTTP 401'],
    [
      buildReply(400, { error: 'invalid_grant', error_description: 'fake-refresh-0' }),
      'invalid_grant',
    ],
    [
      buildReply(400, { error: { code: 'refresh_token_reused', message: 'x' } }),
      'refresh_token_reused',
    ],
    [buildReply(401, { error: { code: 'refresh_token_expired' } }), 'refresh_token_expired'],
    [buildReply(400, { error: 'refresh_token_invalidated' }), 'refresh_token_invalidated'],
  ];

  for (const [answer, error] of permanent) {
    await using ctx = await setupTest();

    await ctx.writeState(buildReadyState());

    ctx.clock.now = T0 + 230 * HOUR;

    ctx.replies.push(answer);

    await ctx.refresher.tick();

    const state = await ctx.readState();

    expect(state).toMatchObject({
      status: 'needs_login',
      error,
      refreshToken: 'fake-refresh-0',
      accessToken: 'fake-access-0',
    });

    expect(ctx.logs).toEqual([`impd: broker: oauth secret codex needs a new sign-in: ${error}`]);

    // never tried again by the timer
    ctx.clock.now += 100 * HOUR;

    await ctx.refresher.tick();

    expect(ctx.calls).toHaveLength(1);

    assertNoTokens(ctx.logs);
  }
});

test('a forced refresh tries a needs_login secret once, and a good answer signs it in again', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildReadyState({ status: 'needs_login', error: 'invalid_grant' }));

  // the timer's refresh is a no-op for it
  const outcome = await ctx.refresher.refresh('codex', false);

  expect(outcome).toEqual({
    kind: 'needs-login',
    error: 'invalid_grant',
  });

  expect(ctx.calls).toHaveLength(0);

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1', expires_in: 3600 }));

  await ctx.refresher.refresh('codex', true);

  const state = await ctx.readState();

  expect(state).toMatchObject({ status: 'ready', error: null });
});

test('a forced refresh while one runs waits for it and answers its outcome', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  const gate = Promise.withResolvers<void>();

  ctx.hold.gate = gate.promise;

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1', expires_in: 3600 }));

  const first = ctx.refresher.refresh('codex', false);
  const second = ctx.refresher.refresh('codex', true);

  gate.resolve();

  const outcomes = await Promise.all([first, second]);

  expect(outcomes[0]).toEqual({ kind: 'refreshed', rotated: false });
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(ctx.calls).toHaveLength(1);
});

test('a result is dropped when the secret was deleted during the call', async () => {
  await using ctx = await setupTest();

  const valueFile = await ctx.writeState(buildPendingState('fake-refresh-0'));

  const before = ctx.files.read(valueFile);
  const gate = Promise.withResolvers<void>();

  ctx.hold.gate = gate.promise;

  ctx.replies.push(
    buildReply(200, { access_token: 'fake-access-1', refresh_token: 'fake-refresh-1' }),
  );

  const running = ctx.refresher.refresh('codex', true);

  while (ctx.calls.length === 0) {
    await Bun.sleep(1);
  }

  // outside the lock, as a bug or a restore would
  await removeSecret(ctx.db, 'codex');

  gate.resolve();

  const outcome = await running;

  expect(outcome).toEqual({ kind: 'dropped' });
  expect(ctx.files.read(valueFile)).toBe(before);
  expect(ctx.logs.join('\n')).toContain('its result was dropped');

  assertNoTokens(ctx.logs);
});

test('a result that cannot be written is kept and written before the next call', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  let failing = true;

  const flaky = createOAuthRefresher({
    db: ctx.db,
    files: {
      read: ctx.files.read,
      rewrite: (file, value) => {
        if (failing) {
          throw new Error('ENOSPC: no space left on device');
        }

        ctx.files.rewrite(file, value);
      },
    },
    log: (message) => {
      ctx.logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => ctx.clock.now,
    fetch: (_url, init) => {
      ctx.calls.push({
        url: _url,
        contentType: null,
        accept: null,
        body: init.body,
        redirect: 'manual',
      });

      return Promise.resolve(
        Response.json({ access_token: 'fake-access-1', refresh_token: 'fake-refresh-1' }),
      );
    },
  });

  await flaky.refresh('codex', true);

  failing = false;

  await flaky.refresh('codex', true);

  // the second call sent the rotated token, from memory, after writing it
  expect(ctx.calls[1]?.body).toContain('refresh_token=fake-refresh-1');

  const state = await ctx.readState();

  expect(state).toMatchObject({ refreshToken: 'fake-refresh-1' });

  assertNoTokens(ctx.logs);
});

test('a missing value file is reported, not refreshed', async () => {
  await using ctx = await setupTest();

  const valueFile = await ctx.writeState(buildPendingState('fake-refresh-0'));

  ctx.files.remove(valueFile);

  const unreadable = await ctx.refresher.refresh('codex', true);
  const gone = await ctx.refresher.refresh('nothing', true);

  expect(unreadable).toEqual({ kind: 'unreadable' });
  expect(gone).toEqual({ kind: 'gone' });
  expect(ctx.calls).toHaveLength(0);
});

test('an answer with only a rotated refresh token keeps the access token and its expiry', async () => {
  await using ctx = await setupTest();

  const expiresAt = T0 + 5 * HOUR;

  await ctx.writeState(buildReadyState({ expiresAt }));

  ctx.replies.push(buildReply(200, { refresh_token: 'fake-refresh-1' }));

  await ctx.refresher.refresh('codex', true);

  const state = await ctx.readState();

  expect(state).toMatchObject({
    refreshToken: 'fake-refresh-1',
    accessToken: 'fake-access-0',
    expiresAt,
  });
});

test('a tick writes a result an earlier write failed on, though the secret is not due', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  const failing = { on: true };

  const flaky = createOAuthRefresher({
    db: ctx.db,
    files: {
      read: ctx.files.read,
      rewrite: (file, value) => {
        if (failing.on) {
          throw new Error('ENOSPC: no space left on device');
        }

        ctx.files.rewrite(file, value);
      },
    },
    log: (message) => {
      ctx.logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => ctx.clock.now,
    fetch: () =>
      Promise.resolve(
        Response.json({
          access_token: 'fake-access-1',
          refresh_token: 'fake-refresh-1',
          expires_in: 240 * 3600,
        }),
      ),
  });

  await flaky.refresh('codex', true);

  const before = await ctx.readState();

  expect(before).toMatchObject({ status: 'pending', refreshToken: 'fake-refresh-0' });

  failing.on = false;

  await flaky.tick();

  const after = await ctx.readState();

  expect(after).toMatchObject({ status: 'ready', refreshToken: 'fake-refresh-1' });
});

test('stop waits for a refresh under way and starts no other', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  const gate = Promise.withResolvers<void>();

  ctx.hold.gate = gate.promise;

  ctx.replies.push(
    buildReply(200, { access_token: 'fake-access-1', refresh_token: 'fake-refresh-1' }),
  );

  const running = ctx.refresher.refresh('codex', true);
  const stopped = ctx.refresher.stop();

  const early = await Promise.race([
    stopped.then(() => 'stopped'),
    Bun.sleep(20).then(() => 'waiting'),
  ]);

  expect(early).toBe('waiting');

  gate.resolve();

  await stopped;

  const outcome = await running;
  const state = await ctx.readState();
  const later = await ctx.refresher.refresh('codex', true);

  expect(outcome).toEqual({ kind: 'refreshed', rotated: true });
  expect(state).toMatchObject({ refreshToken: 'fake-refresh-1' });
  expect(later).toMatchObject({ kind: 'transient' });
  expect(ctx.calls).toHaveLength(1);
});

test('a rotated refresh token alone on a pending secret is kept, not dropped', async () => {
  await using ctx = await setupTest();

  await ctx.writeState(buildPendingState('fake-refresh-0'));

  ctx.replies.push(buildReply(200, { refresh_token: 'fake-refresh-1' }));

  const outcome = await ctx.refresher.refresh('codex', true);
  const state = await ctx.readState();

  expect(outcome).toMatchObject({ kind: 'transient' });
  expect(state).toMatchObject({ status: 'pending', refreshToken: 'fake-refresh-1' });
});

// a refresher whose writes fail while `failing.on` and are counted
async function setupFlakyTest() {
  const ctx = await setupTest();

  const failing = { on: true };
  const writes: string[] = [];

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: {
      read: ctx.files.read,
      rewrite: (file, value) => {
        if (failing.on) {
          throw new Error('ENOSPC: no space left on device');
        }

        writes.push(file);
        ctx.files.rewrite(file, value);
      },
    },
    log: (message) => {
      ctx.logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => ctx.clock.now,
    fetch: () =>
      Promise.resolve(
        Response.json({
          access_token: 'fake-access-1',
          refresh_token: 'fake-refresh-1',
          expires_in: 240 * 3600,
        }),
      ),
  });

  return {
    ctx,
    failing,
    writes,
    refresher,
    [Symbol.asyncDispose]: () => ctx[Symbol.asyncDispose](),
  };
}

test('stop writes a result an earlier write failed on', async () => {
  await using flaky = await setupFlakyTest();

  await flaky.ctx.writeState(buildPendingState('fake-refresh-0'));
  await flaky.refresher.refresh('codex', true);

  flaky.failing.on = false;

  await flaky.refresher.stop();

  const state = await flaky.ctx.readState();

  expect(state).toMatchObject({ status: 'ready', refreshToken: 'fake-refresh-1' });
});

test('an unsaved result is not written for a secret deleted while the tick waited', async () => {
  await using flaky = await setupFlakyTest();

  await flaky.ctx.writeState(buildPendingState('fake-refresh-0'));
  await flaky.refresher.refresh('codex', true);

  flaky.failing.on = false;

  // hold the lock so the tick has listed the row and waits behind it
  const gate = Promise.withResolvers<void>();
  const holder = flaky.refresher.withLock('codex', () => gate.promise);
  const ticking = flaky.refresher.tick();

  await Bun.sleep(20);

  await removeSecret(flaky.ctx.db, 'codex');

  gate.resolve();

  await holder;
  await ticking;

  expect(flaky.writes).toHaveLength(0);
});
