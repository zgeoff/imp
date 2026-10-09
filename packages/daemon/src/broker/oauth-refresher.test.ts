import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockBrokerRule } from '@imp/api/test-utils/build-mock-broker-rule';
import { buildMockOAuthConfig } from '@imp/api/test-utils/build-mock-oauth-config';
import { invariant } from '@imp/test-utils/invariant';
import { server } from '@imp/test-utils/mock-server';
import { HttpResponse, delay, http } from 'msw';
import { createSecret, removeSecret } from '../db/secrets';
import { buildMockOAuthStateFile } from '../test-utils/build-mock-oauth-state-file';
import { buildQueryGate } from '../test-utils/build-query-gate';
import { buildStubBrokerJwt } from '../test-utils/build-stub-broker-jwt';
import { buildStubBrokerTokenEndpoint } from '../test-utils/build-stub-broker-token-endpoint';
import { createTestDatabase } from '../test-utils/create-test-database';
import { startStubBrokerTlsUpstream } from '../test-utils/start-stub-broker-tls-upstream';
import { loadOrCreateBrokerCa } from './broker-ca';
import { createOAuthRefresher, isDue } from './oauth-refresher';
import { buildPendingState, formatOAuthState, parseOAuthState } from './oauth-state';
import { buildValueFile, createSecretFiles } from './secret-files';

// Every token here is made up; the token endpoint answers through MSW.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'oauth-refresher-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const testDatabase = await createTestDatabase();

  return { stack, db: testDatabase.db, dataDir, files: createSecretFiles(dataDir) };
}

test('it sends the refresh token and the client id as a form', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'form',
    }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  await refresher.refresh('codex', true);

  expect(endpoint.requests).toStrictEqual([
    {
      contentType: 'application/x-www-form-urlencoded',
      accept: 'application/json',
      body: 'grant_type=refresh_token&refresh_token=fake-refresh-0&client_id=fake-client',
      refreshToken: 'fake-refresh-0',
    },
  ]);
});

test('it sends a JSON body for the json format', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 60 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  await refresher.refresh('codex', true);

  expect(endpoint.requests).toStrictEqual([
    {
      contentType: 'application/json',
      accept: 'application/json',
      body: '{"grant_type":"refresh_token","refresh_token":"fake-refresh-0","client_id":"fake-client"}',
      refreshToken: 'fake-refresh-0',
    },
  ]);
});

test('it sends the token request to the test upstream that stands in for the token host', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://upstream.test:9443/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: () => ({ origin: 'https://upstream.test:9443', ca: ['TEST CA'] }),
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'refreshed', rotated: false });
  expect(endpoint.requests).toHaveLength(1);
});

test('it refreshes over TLS from a test upstream that the test CA signed', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    dir: ctx.dataDir,
    fetch: () => Response.json({ access_token: 'fake-access-1', expires_in: 3600 }),
  });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: () => ({ origin: upstream.origin, ca: [upstream.caPem] }),
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'refreshed', rotated: false });
});

test('it treats a test upstream whose certificate the test CA did not sign as a network error', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    dir: ctx.dataDir,
    fetch: () => Response.json({ access_token: 'fake-access-1', expires_in: 3600 }),
  });

  const other = await loadOrCreateBrokerCa(join(ctx.dataDir, 'other-ca'));

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: () => ({ origin: upstream.origin, ca: [other.certPem] }),
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'transient', error: 'network error' });
});

test('it stores the rotated tokens with the expiry expires_in gives', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    id_token: 'fake-id-1',
    expires_in: 7200,
  });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt,
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'refreshed', rotated: true });

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-1',
    accessToken: 'fake-access-1',
    idToken: 'fake-id-1',
    expiresAt: startedAt + 2 * 3_600_000,
    refreshedAt: startedAt,
    status: 'ready',
    error: null,
  });
});

test('it logs a refresh with whether the token rotated and its expiry, and no token', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const logs: string[] = [];

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    id_token: 'fake-id-1',
    expires_in: 7200,
  });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: (message) => {
      logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => Date.parse('2030-01-01T00:00:00Z'),
  });

  await refresher.refresh('codex', true);

  expect(logs).toStrictEqual([
    'impd: broker: oauth secret codex refreshed; refresh token rotated: yes; expires 2030-01-01T02:00:00.000Z',
  ]);
});

test('it keeps the old value of a field the answer leaves out', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({
        refreshToken: 'fake-refresh-0',
        accessToken: 'fake-access-0',
        idToken: 'fake-id-0',
        expiresAt: startedAt + 240 * 3_600_000,
        refreshedAt: startedAt,
      }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt,
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'refreshed', rotated: false });

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-0',
    accessToken: 'fake-access-1',
    idToken: 'fake-id-0',
    expiresAt: startedAt + 3_600_000,
    refreshedAt: startedAt,
    status: 'ready',
    error: null,
  });
});

test('it logs a refresh whose refresh token did not rotate as such', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const logs: string[] = [];

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(buildMockOAuthStateFile({ refreshToken: 'fake-refresh-0' })),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: (message) => {
      logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => Date.parse('2030-01-01T00:00:00Z'),
  });

  await refresher.refresh('codex', true);

  expect(logs).toStrictEqual([
    'impd: broker: oauth secret codex refreshed; refresh token rotated: no; expires 2030-01-01T01:00:00.000Z',
  ]);
});

test('it takes the expiry from expires_in over the access token exp', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: buildStubBrokerJwt({ exp: Math.floor((startedAt + 10 * 3_600_000) / 1000) }),
    expires_in: 3600,
  });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt,
  });

  await refresher.refresh('codex', true);

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')?.expiresAt).toBe(startedAt + 3_600_000);
});

test('it takes the expiry from the access token exp without expires_in', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: buildStubBrokerJwt({ exp: Math.floor((startedAt + 10 * 3_600_000) / 1000) }),
  });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt,
  });

  await refresher.refresh('codex', true);

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')?.expiresAt).toBe(
    startedAt + 10 * 3_600_000,
  );
});

test('it stores no expiry for an opaque access token without expires_in', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-opaque' });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => Date.parse('2030-01-01T00:00:00Z'),
  });

  await refresher.refresh('codex', true);

  const state = parseOAuthState(ctx.files.read(valueFile) ?? '');

  invariant(state);

  expect(state.expiresAt).toBeNull();
});

test('it stores no expiry for an expires_in no date can hold, and keeps the rotated tokens', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 1e20,
  });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt,
  });

  await refresher.refresh('codex', true);

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-1',
    accessToken: 'fake-access-1',
    idToken: null,
    expiresAt: null,
    refreshedAt: startedAt,
    status: 'ready',
    error: null,
  });
});

test.each([[0], [-60]])(
  'it stores an expires_in of %i as due now, not unknown',
  async (expiresIn) => {
    const ctx = await setupTest();

    const startedAt = Date.parse('2030-01-01T00:00:00Z');
    const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

    server.use(endpoint.handler);
    endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: expiresIn });

    const valueFile = buildValueFile('codex');

    ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

    await createSecret(ctx.db, {
      name: 'codex',
      kind: 'oauth',
      rules: [buildMockBrokerRule()],
      oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
      valueFile,
    });

    const refresher = createOAuthRefresher({
      db: ctx.db,
      files: ctx.files,
      log: () => {},
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      now: () => startedAt,
    });

    await refresher.refresh('codex', true);

    expect(parseOAuthState(ctx.files.read(valueFile) ?? '')?.expiresAt).toBe(startedAt);
  },
);

test('it keeps the access token and its expiry when the answer has only a rotated refresh token', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { refresh_token: 'fake-refresh-1', expires_in: 3600 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({
        refreshToken: 'fake-refresh-0',
        accessToken: 'fake-access-0',
        idToken: 'fake-id-0',
        expiresAt: startedAt + 5 * 3_600_000,
        refreshedAt: startedAt - 3_600_000,
      }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt,
  });

  await refresher.refresh('codex', true);

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-1',
    accessToken: 'fake-access-0',
    idToken: 'fake-id-0',
    expiresAt: startedAt + 5 * 3_600_000,
    refreshedAt: startedAt,
    status: 'ready',
    error: null,
  });
});

test('it keeps a rotated refresh token alone on a pending secret and stays pending', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { refresh_token: 'fake-refresh-1' });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => Date.parse('2030-01-01T00:00:00Z'),
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'transient', error: 'no access token in the response' });

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-1',
    accessToken: null,
    idToken: null,
    expiresAt: null,
    refreshedAt: null,
    status: 'pending',
    error: 'no access token in the response',
  });
});

test('it records a 200 with no token as a transient error that changes nothing else', async () => {
  const ctx = await setupTest();

  const state = buildMockOAuthStateFile({ status: 'ready', error: null });

  server.use(http.post('https://auth.example.com/oauth/token', () => HttpResponse.json({})));

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(state));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'transient', error: 'no token in the response' });

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    ...state,
    error: 'no token in the response',
  });
});

test('it leaves the old expiry when expires_in comes with no new access token', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { refresh_token: 'fake-refresh-1', expires_in: 3600 });

  const valueFile = buildValueFile('codex');

  const state = buildMockOAuthStateFile({
    refreshToken: 'fake-refresh-0',
    expiresAt: startedAt + 10_000,
  });

  ctx.files.write(valueFile, formatOAuthState(state));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt,
  });

  await refresher.refresh('codex', true);

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    ...state,
    refreshToken: 'fake-refresh-1',
    expiresAt: startedAt + 10_000,
    refreshedAt: startedAt,
  });
});

test('it holds a 240 hour token not due with more than 24 hours left', () => {
  const refreshedAt = Date.parse('2030-01-01T00:00:00Z');
  const state = buildMockOAuthStateFile({ refreshedAt, expiresAt: refreshedAt + 240 * 3_600_000 });

  expect(isDue(state, refreshedAt + 215 * 3_600_000)).toBeFalse();
});

test('it holds a 240 hour token due with less than 24 hours left', () => {
  const refreshedAt = Date.parse('2030-01-01T00:00:00Z');
  const state = buildMockOAuthStateFile({ refreshedAt, expiresAt: refreshedAt + 240 * 3_600_000 });

  expect(isDue(state, refreshedAt + 217 * 3_600_000)).toBeTrue();
});

test('it holds a short token not due before half its lifetime', () => {
  const refreshedAt = Date.parse('2030-01-01T00:00:00Z');
  const state = buildMockOAuthStateFile({ refreshedAt, expiresAt: refreshedAt + 2 * 3_600_000 });

  expect(isDue(state, refreshedAt + 0.9 * 3_600_000)).toBeFalse();
});

test('it holds a short token due past half its lifetime', () => {
  const refreshedAt = Date.parse('2030-01-01T00:00:00Z');
  const state = buildMockOAuthStateFile({ refreshedAt, expiresAt: refreshedAt + 2 * 3_600_000 });

  expect(isDue(state, refreshedAt + 1.1 * 3_600_000)).toBeTrue();
});

test('it is due at once for a token shorter than a tick and a token call', () => {
  const refreshedAt = Date.parse('2030-01-01T00:00:00Z');

  expect(
    isDue(buildMockOAuthStateFile({ refreshedAt, expiresAt: refreshedAt + 60_000 }), refreshedAt),
  ).toBeTrue();
});

test('it is due at once for a short token never refreshed', () => {
  const at = Date.parse('2030-01-01T00:00:00Z');

  expect(
    isDue(buildMockOAuthStateFile({ refreshedAt: null, expiresAt: at + 60_000 }), at),
  ).toBeTrue();
});

test('it holds a token with no expiry not due within an hour of a refresh', () => {
  const refreshedAt = Date.parse('2030-01-01T00:00:00Z');
  const state = buildMockOAuthStateFile({ refreshedAt, expiresAt: null });

  expect(isDue(state, refreshedAt + 0.9 * 3_600_000)).toBeFalse();
});

test('it holds a token with no expiry due an hour after a refresh', () => {
  const refreshedAt = Date.parse('2030-01-01T00:00:00Z');
  const state = buildMockOAuthStateFile({ refreshedAt, expiresAt: null });

  expect(isDue(state, refreshedAt + 1.1 * 3_600_000)).toBeTrue();
});

test('it is due at once for a pending secret', () => {
  expect(isDue(buildPendingState('fake-refresh-0'), Date.parse('2030-01-01T00:00:00Z'))).toBeTrue();
});

test('it is due at once for a secret with no access token', () => {
  const at = Date.parse('2030-01-01T00:00:00Z');

  expect(isDue(buildMockOAuthStateFile({ accessToken: null, refreshedAt: at }), at)).toBeTrue();
});

test('it is never due for a secret that needs a new sign-in', () => {
  const refreshedAt = Date.parse('2030-01-01T00:00:00Z');

  const state = buildMockOAuthStateFile({
    status: 'needs_login',
    refreshedAt,
    expiresAt: refreshedAt + 240 * 3_600_000,
  });

  expect(isDue(state, refreshedAt + 1000 * 3_600_000)).toBeFalse();
});

test('it refreshes a secret that is due on a tick and leaves one that is not', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-due', { access_token: 'fake-access-1', expires_in: 3600 });

  const dueFile = buildValueFile('due');
  const freshFile = buildValueFile('fresh');

  ctx.files.write(
    dueFile,
    formatOAuthState(
      buildMockOAuthStateFile({
        refreshToken: 'fake-refresh-due',
        refreshedAt: startedAt,
        expiresAt: startedAt + 240 * 3_600_000,
      }),
    ),
  );

  ctx.files.write(
    freshFile,
    formatOAuthState(
      buildMockOAuthStateFile({
        refreshToken: 'fake-refresh-fresh',
        refreshedAt: startedAt,
        expiresAt: startedAt + 480 * 3_600_000,
      }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'due',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile: dueFile,
  });

  await createSecret(ctx.db, {
    name: 'fresh',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile: freshFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt + 230 * 3_600_000,
  });

  await refresher.tick();

  expect(endpoint.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-due',
  ]);
});

test('it sends nothing on the next tick after a refresh', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt,
  });

  await refresher.tick();
  await refresher.tick();

  expect(endpoint.requests).toHaveLength(1);
});

test('it keeps the tokens and the status on a transient error and records the error', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');

  const state = buildMockOAuthStateFile({
    refreshedAt: startedAt,
    expiresAt: startedAt + 240 * 3_600_000,
  });

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ error: 'server_error' }, { status: 503 }),
    ),
  );

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(state));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt + 230 * 3_600_000,
  });

  await refresher.tick();

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    ...state,
    error: 'HTTP 503',
  });
});

test('it logs a transient error without the body it came with', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const logs: string[] = [];

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ error: 'server_error', detail: 'fake-refresh-0' }, { status: 503 }),
    ),
  );

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({
        refreshToken: 'fake-refresh-0',
        refreshedAt: startedAt,
        expiresAt: startedAt + 240 * 3_600_000,
      }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: (message) => {
      logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt + 230 * 3_600_000,
  });

  await refresher.tick();

  expect(logs).toStrictEqual([
    'impd: broker: oauth secret codex could not refresh: HTTP 503; trying again in 1 min',
  ]);
});

test('it sends nothing for a minute after a transient error', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const clock = { nowMs: startedAt + 230 * 3_600_000 };
  const requests: string[] = [];

  server.use(
    http.post('https://auth.example.com/oauth/token', (info) => {
      requests.push(info.request.url);

      return HttpResponse.json({ error: 'server_error' }, { status: 503 });
    }),
  );

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({ refreshedAt: startedAt, expiresAt: startedAt + 240 * 3_600_000 }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => clock.nowMs,
  });

  await refresher.tick();

  clock.nowMs += 59_000;

  await refresher.tick();

  expect(requests).toHaveLength(1);
});

test('it tries again a minute after a transient error', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const clock = { nowMs: startedAt + 230 * 3_600_000 };
  const requests: string[] = [];

  server.use(
    http.post('https://auth.example.com/oauth/token', (info) => {
      requests.push(info.request.url);

      return HttpResponse.json({ error: 'server_error' }, { status: 503 });
    }),
  );

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({ refreshedAt: startedAt, expiresAt: startedAt + 240 * 3_600_000 }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => clock.nowMs,
  });

  await refresher.tick();

  clock.nowMs += 61_000;

  await refresher.tick();

  expect(requests).toHaveLength(2);
});

test('it waits two minutes after a second transient error', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const clock = { nowMs: startedAt + 230 * 3_600_000 };
  const requests: string[] = [];

  server.use(
    http.post('https://auth.example.com/oauth/token', (info) => {
      requests.push(info.request.url);

      return HttpResponse.json({ error: 'server_error' }, { status: 503 });
    }),
  );

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({ refreshedAt: startedAt, expiresAt: startedAt + 240 * 3_600_000 }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => clock.nowMs,
  });

  await refresher.tick();

  clock.nowMs += 61_000;

  await refresher.tick();

  clock.nowMs += 119_000;

  await refresher.tick();

  expect(requests).toHaveLength(2);
});

test('it caps the wait between transient errors at 30 minutes', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const clock = { nowMs: startedAt + 230 * 3_600_000 };
  const logs: string[] = [];

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ error: 'server_error' }, { status: 503 }),
    ),
  );

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({ refreshedAt: startedAt, expiresAt: startedAt + 240 * 3_600_000 }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: (message) => {
      logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => clock.nowMs,
  });

  // past the 1, 2, 4, 8 and 16 minute waits, each tick fails once more
  for (let index = 0; index < 6; index += 1) {
    await refresher.tick();

    clock.nowMs += 31 * 60_000;
  }

  expect(logs.map((line) => line.split('; ').at(-1))).toStrictEqual([
    'trying again in 1 min',
    'trying again in 2 min',
    'trying again in 4 min',
    'trying again in 8 min',
    'trying again in 16 min',
    'trying again in 30 min',
  ]);
});

test('it clears the error once a refresh after a transient error succeeds', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const clock = { nowMs: startedAt + 230 * 3_600_000 };
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      () => HttpResponse.json({ error: 'server_error' }, { status: 503 }),
      { once: true },
    ),
  );

  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 7200 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({
        refreshToken: 'fake-refresh-0',
        refreshedAt: startedAt,
        expiresAt: startedAt + 240 * 3_600_000,
      }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => clock.nowMs,
  });

  await refresher.tick();

  const failed = parseOAuthState(ctx.files.read(valueFile) ?? '');

  clock.nowMs += 61_000;

  await refresher.tick();

  const recovered = parseOAuthState(ctx.files.read(valueFile) ?? '');

  expect(failed?.error).toBe('HTTP 503');
  expect(recovered?.error).toBeNull();
  expect(recovered?.accessToken).toBe('fake-access-1');
});

test('it leaves a pending secret pending on a network error', async () => {
  const ctx = await setupTest();

  server.use(http.post('https://auth.example.com/oauth/token', () => HttpResponse.error()));

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'transient', error: 'network error' });

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    ...buildPendingState('fake-refresh-0'),
    error: 'network error',
  });
});

test('it treats a redirect as transient and keeps the live tokens', async () => {
  const ctx = await setupTest();

  const state = buildMockOAuthStateFile();

  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      () =>
        new HttpResponse(null, { status: 302, headers: { location: 'https://evil.example.com' } }),
    ),
  );

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(state));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'transient', error: 'HTTP 302' });

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
    ...state,
    error: 'HTTP 302',
  });
});

test('it treats an answer that is not JSON as an invalid response and keeps the stored tokens', async () => {
  const ctx = await setupTest();

  server.use(
    http.post('https://auth.example.com/oauth/token', () => HttpResponse.html('<html>nope</html>')),
  );

  const state = buildMockOAuthStateFile();
  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(state));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const outcome = await refresher.refresh('codex', true);

  const stored = parseOAuthState(ctx.files.read(valueFile) ?? '');

  expect(outcome).toStrictEqual({ kind: 'transient', error: 'invalid response' });
  expect(stored?.refreshToken).toBe(state.refreshToken);
  expect(stored?.accessToken).toBe(state.accessToken);
  expect(stored?.idToken).toBe(state.idToken);
});

test.each([['has space'], ['bad\r\nx-evil: 1']])(
  'it treats the access token %j, which could split a header, as invalid and keeps the stored tokens',
  async (accessToken) => {
    const ctx = await setupTest();

    server.use(
      http.post('https://auth.example.com/oauth/token', () =>
        HttpResponse.json({ access_token: accessToken }),
      ),
    );

    const state = buildMockOAuthStateFile();
    const valueFile = buildValueFile('codex');

    ctx.files.write(valueFile, formatOAuthState(state));

    await createSecret(ctx.db, {
      name: 'codex',
      kind: 'oauth',
      rules: [buildMockBrokerRule()],
      oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
      valueFile,
    });

    const refresher = createOAuthRefresher({
      db: ctx.db,
      files: ctx.files,
      log: () => {},
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    });

    const outcome = await refresher.refresh('codex', true);

    const stored = parseOAuthState(ctx.files.read(valueFile) ?? '');

    expect(outcome).toStrictEqual({ kind: 'transient', error: 'invalid response' });
    expect(stored?.refreshToken).toBe(state.refreshToken);
    expect(stored?.accessToken).toBe(state.accessToken);
    expect(stored?.idToken).toBe(state.idToken);
  },
);

test('it treats a call that outlasts the timeout as transient', async () => {
  const ctx = await setupTest();

  server.use(
    http.post('https://auth.example.com/oauth/token', async () => {
      await delay('infinite');

      return HttpResponse.json({});
    }),
  );

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  // a deadline that has passed by the time the call is under way
  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    timeoutMs: 0,
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'transient', error: 'timeout' });
});

test.each([
  [401, { message: 'no' }, 'HTTP 401'],
  [400, { error: 'invalid_grant', error_description: 'fake-refresh-0' }, 'invalid_grant'],
  [400, { error: { code: 'refresh_token_reused', message: 'x' } }, 'refresh_token_reused'],
  [401, { error: { code: 'refresh_token_expired' } }, 'refresh_token_expired'],
  [400, { error: 'refresh_token_invalidated' }, 'refresh_token_invalidated'],
  [400, { error: { error: 'invalid_grant' } }, 'invalid_grant'],
  [401, { error: 'server_busy' }, 'server_busy'],
])(
  'it marks the secret as needing a new sign-in on a %i answer of %j',
  async (status, body, error) => {
    const ctx = await setupTest();

    const state = buildMockOAuthStateFile({ refreshToken: 'fake-refresh-0' });
    const logs: string[] = [];

    server.use(
      http.post('https://auth.example.com/oauth/token', () => HttpResponse.json(body, { status })),
    );

    const valueFile = buildValueFile('codex');

    ctx.files.write(valueFile, formatOAuthState(state));

    await createSecret(ctx.db, {
      name: 'codex',
      kind: 'oauth',
      rules: [buildMockBrokerRule()],
      oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
      valueFile,
    });

    const refresher = createOAuthRefresher({
      db: ctx.db,
      files: ctx.files,
      log: (message) => {
        logs.push(message);
      },
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    });

    const outcome = await refresher.refresh('codex', true);

    expect(outcome).toStrictEqual({ kind: 'needs-login', error });

    expect(parseOAuthState(ctx.files.read(valueFile) ?? '')).toStrictEqual({
      ...state,
      status: 'needs_login',
      error,
    });

    expect(logs).toStrictEqual([`impd: broker: oauth secret codex needs a new sign-in: ${error}`]);
  },
);

test('it never sends a secret that needs a new sign-in on a tick', async () => {
  const ctx = await setupTest();

  const startedAt = Date.parse('2030-01-01T00:00:00Z');
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({
        status: 'needs_login',
        error: 'invalid_grant',
        refreshedAt: startedAt,
        expiresAt: startedAt + 240 * 3_600_000,
      }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    now: () => startedAt + 1000 * 3_600_000,
  });

  await refresher.tick();

  expect(endpoint.requests).toBeEmpty();
});

test('it answers an unforced refresh of a secret that needs a new sign-in without a call', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(buildMockOAuthStateFile({ status: 'needs_login', error: 'invalid_grant' })),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const outcome = await refresher.refresh('codex', false);

  expect(outcome).toStrictEqual({ kind: 'needs-login', error: 'invalid_grant' });
  expect(endpoint.requests).toBeEmpty();
});

test('it signs a secret that needs a new sign-in in again on a forced refresh with a good answer', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({
        refreshToken: 'fake-refresh-0',
        status: 'needs_login',
        error: 'invalid_grant',
      }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  await refresher.refresh('codex', true);

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')?.status).toBe('ready');
});

test('it logs nothing when a secret that already needs a new sign-in is refused again', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const logs: string[] = [];

  server.use(endpoint.handler);

  const valueFile = buildValueFile('codex');

  ctx.files.write(
    valueFile,
    formatOAuthState(
      buildMockOAuthStateFile({
        refreshToken: 'fake-refresh-dead',
        status: 'needs_login',
        error: 'invalid_grant',
      }),
    ),
  );

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: (message) => {
      logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'needs-login', error: 'invalid_grant' });
  expect(logs).toStrictEqual([]);
});

test('it answers a forced refresh while one runs with that one, sending one request', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  server.use(endpoint.handler);

  server.use(
    http.post('https://auth.example.com/oauth/token', async () => {
      reached.resolve();

      await gate.promise;
    }),
  );

  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const first = refresher.refresh('codex', false);

  await reached.promise;

  const second = refresher.refresh('codex', true);

  gate.resolve();

  const outcomes = await Promise.all([first, second]);

  expect(outcomes).toStrictEqual([
    { kind: 'refreshed', rotated: false },
    { kind: 'refreshed', rotated: false },
  ]);

  expect(endpoint.requests).toHaveLength(1);
});

test('it drops a result when the secret was deleted during the call', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const logs: string[] = [];

  server.use(endpoint.handler);

  server.use(
    http.post('https://auth.example.com/oauth/token', async () => {
      reached.resolve();

      await gate.promise;
    }),
  );

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
  });

  const valueFile = buildValueFile('codex');
  const before = formatOAuthState(buildPendingState('fake-refresh-0'));

  ctx.files.write(valueFile, before);

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: (message) => {
      logs.push(message);
    },
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const running = refresher.refresh('codex', true);

  await reached.promise;

  // outside the lock, as a bug or a restore would
  await removeSecret(ctx.db, 'codex');

  gate.resolve();

  const outcome = await running;

  expect(outcome).toStrictEqual({ kind: 'dropped' });
  expect(ctx.files.read(valueFile)).toStrictEqual(before);

  expect(logs).toStrictEqual([
    'impd: broker: oauth secret codex was replaced or deleted during a refresh; its result was dropped',
  ]);
});

test('it keeps a result it could not write and sends its rotated token on the next call', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const valueFile = buildValueFile('codex');
  const valuePath = join(ctx.dataDir, 'secrets', valueFile);

  server.use(endpoint.handler);

  // read by then: a directory where the file goes fails the write's rename
  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      () => {
        rmSync(valuePath);
        mkdirSync(valuePath);
        writeFileSync(join(valuePath, 'keep'), 'x');
      },
      { once: true },
    ),
  );

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
  });

  endpoint.issue('fake-refresh-1', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
  });

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  await refresher.refresh('codex', true);

  rmSync(valuePath, { recursive: true });

  await refresher.refresh('codex', true);

  expect(endpoint.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-0',
    'fake-refresh-1',
  ]);

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')?.refreshToken).toBe('fake-refresh-2');
});

test('it answers a refresh whose earlier result still cannot be written without a call', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const valueFile = buildValueFile('codex');
  const valuePath = join(ctx.dataDir, 'secrets', valueFile);

  server.use(endpoint.handler);

  // read by then: a directory where the file goes fails the write's rename
  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      () => {
        rmSync(valuePath);
        mkdirSync(valuePath);
        writeFileSync(join(valuePath, 'keep'), 'x');
      },
      { once: true },
    ),
  );

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
  });

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  await refresher.refresh('codex', true);

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'transient', error: 'value file not writable' });
  expect(endpoint.requests).toHaveLength(1);
});

test('it writes on a tick a result an earlier write failed on, though the secret is not due', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const valueFile = buildValueFile('codex');
  const valuePath = join(ctx.dataDir, 'secrets', valueFile);

  server.use(endpoint.handler);

  // read by then: a directory where the file goes fails the write's rename
  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      () => {
        rmSync(valuePath);
        mkdirSync(valuePath);
        writeFileSync(join(valuePath, 'keep'), 'x');
      },
      { once: true },
    ),
  );

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 240 * 3600,
  });

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  await refresher.refresh('codex', true);

  rmSync(valuePath, { recursive: true });

  await refresher.tick();

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')?.refreshToken).toBe('fake-refresh-1');
});

test('it writes on stop a result an earlier write failed on', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const valueFile = buildValueFile('codex');
  const valuePath = join(ctx.dataDir, 'secrets', valueFile);

  server.use(endpoint.handler);

  // read by then: a directory where the file goes fails the write's rename
  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      () => {
        rmSync(valuePath);
        mkdirSync(valuePath);
        writeFileSync(join(valuePath, 'keep'), 'x');
      },
      { once: true },
    ),
  );

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 240 * 3600,
  });

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  await refresher.refresh('codex', true);

  rmSync(valuePath, { recursive: true });

  await refresher.stop();

  expect(parseOAuthState(ctx.files.read(valueFile) ?? '')?.refreshToken).toBe('fake-refresh-1');
});

test('it never writes an unsaved result for a secret deleted after the tick listed it', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const valueFile = buildValueFile('codex');
  const valuePath = join(ctx.dataDir, 'secrets', valueFile);
  const gate = buildQueryGate('secrets');

  server.use(endpoint.handler);

  // read by then: a directory where the file goes fails the write's rename
  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      () => {
        rmSync(valuePath);
        mkdirSync(valuePath);
        writeFileSync(join(valuePath, 'keep'), 'x');
      },
      { once: true },
    ),
  );

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 240 * 3600,
  });

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db.withPlugin(gate.plugin),
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  await refresher.refresh('codex', true);

  rmSync(valuePath, { recursive: true });

  // the tick's list of secrets is held until the row is gone
  gate.arm();

  const ticking = refresher.tick();

  await gate.reached;
  await removeSecret(ctx.db, 'codex');

  gate.release();

  await ticking;

  expect(ctx.files.read(valueFile)).toBeNull();
});

test('it answers stop only after the refresh under way has ended', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const settled: string[] = [];

  server.use(endpoint.handler);

  server.use(
    http.post('https://auth.example.com/oauth/token', async () => {
      reached.resolve();

      await gate.promise;
    }),
  );

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
  });

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const running = (async () => {
    const outcome = await refresher.refresh('codex', true);

    settled.push(`refresh ${outcome.kind}`);
  })();

  await reached.promise;

  const stopped = (async () => {
    await refresher.stop();

    settled.push('stop');
  })();

  gate.resolve();

  await Promise.all([running, stopped]);

  expect(settled).toStrictEqual(['refresh refreshed', 'stop']);
});

test('it answers a refresh after stop as transient without a call', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  const valueFile = buildValueFile('codex');

  ctx.files.write(valueFile, formatOAuthState(buildPendingState('fake-refresh-0')));

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  await refresher.stop();

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'transient', error: 'impd is stopping' });
  expect(endpoint.requests).toBeEmpty();
});

test('it reports a secret whose value file is missing as unreadable without a call', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  await createSecret(ctx.db, {
    name: 'codex',
    kind: 'oauth',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    valueFile: buildValueFile('codex'),
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const outcome = await refresher.refresh('codex', true);

  expect(outcome).toStrictEqual({ kind: 'unreadable' });
  expect(endpoint.requests).toBeEmpty();
});

test('it reports a secret that does not exist as gone', async () => {
  const ctx = await setupTest();

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const outcome = await refresher.refresh('nothing', true);

  expect(outcome).toStrictEqual({ kind: 'gone' });
});

test('it reports a secret of another kind as gone', async () => {
  const ctx = await setupTest();

  const valueFile = buildValueFile('gh');

  ctx.files.write(valueFile, 'ghp_value');

  await createSecret(ctx.db, {
    name: 'gh',
    kind: 'custom',
    rules: [buildMockBrokerRule()],
    valueFile,
  });

  const refresher = createOAuthRefresher({
    db: ctx.db,
    files: ctx.files,
    log: () => {},
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
  });

  const outcome = await refresher.refresh('gh', true);

  expect(outcome).toStrictEqual({ kind: 'gone' });
});
