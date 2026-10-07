import { expect, test } from 'bun:test';
import type { NewAuditEntry } from '../db/broker-audit';
import { createForwarder } from './forward-request';
import type { Credential, ForwardDeps, UpstreamInit } from './forward-request';

interface Sent {
  readonly url: string;
  readonly init: UpstreamInit;
}

function setupForwarder(overrides: Partial<ForwardDeps> = {}) {
  const sent: Sent[] = [];
  const audits: NewAuditEntry[] = [];

  const credential: Credential = {
    secretName: 'gh',
    header: 'authorization',
    value: 'Bearer real',
  };

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () => Promise.resolve(credential),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: (entry) => {
      audits.push(entry);
    },
    fetch: (url, init) => {
      sent.push({ url, init });

      return Promise.resolve(
        new Response('upstream body', {
          status: 201,
          headers: { 'content-encoding': 'gzip', connection: 'close', 'x-up': '1' },
        }),
      );
    },
    ...overrides,
  });

  return { forward, sent, audits };
}

function readHeaders(sent: Sent | undefined): Headers {
  return new Headers(sent?.init.headers);
}

test('it sends the path to the bound host with the real credential in place of the guest one', async () => {
  const ctx = setupForwarder();

  const response = await ctx.forward(
    new Request('https://api.github.com/repos/a/b?token=secret', {
      method: 'POST',
      headers: {
        host: 'api.github.com',
        authorization: 'Bearer imp-broker-placeholder',
        'proxy-authorization': 'Basic x',
        connection: 'keep-alive, x-drop',
        'x-drop': '1',
        'x-keep': '1',
      },
      body: 'payload',
    }),
  );

  const headers = readHeaders(ctx.sent[0]);

  expect(ctx.sent[0]?.url).toBe('https://api.github.com/repos/a/b?token=secret');

  expect(ctx.sent[0]?.init).toMatchObject({
    method: 'POST',
    redirect: 'manual',
    decompress: false,
  });

  expect(headers.get('authorization')).toBe('Bearer real');
  expect(headers.get('x-keep')).toBe('1');

  for (const dropped of ['proxy-authorization', 'connection', 'x-drop', 'host']) {
    expect({ dropped, value: headers.get(dropped) }).toEqual({ dropped, value: null });
  }

  expect(response.status).toBe(201);
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(response.headers.get('connection')).toBeNull();

  const text = await response.text();

  expect(text).toBe('upstream body');

  // the row has the path without its query, and the bytes each way
  expect(ctx.audits).toMatchObject([
    {
      impId: 'imp-1',
      secretName: 'gh',
      method: 'POST',
      host: 'api.github.com',
      path: '/repos/a/b',
      status: 201,
      responseBytes: 'upstream body'.length,
    },
  ]);
});

test('a Host header for another name is refused, and an absolute target keeps the bound host', async () => {
  const ctx = setupForwarder();

  const misdirected = await ctx.forward(
    new Request('https://evil.test/x', { headers: { host: 'evil.test' } }),
  );

  expect(misdirected.status).toBe(421);
  expect(ctx.sent).toHaveLength(0);

  // the request line named another host; only its path is used
  await ctx.forward(
    new Request('https://evil.test/steal', { headers: { host: 'API.github.com:443' } }),
  );

  expect(ctx.sent[0]?.url).toBe('https://api.github.com/steal');
});

test('a revoked grant is refused before anything goes upstream', async () => {
  const ctx = setupForwarder({ findCredential: () => Promise.resolve(null) });

  const response = await ctx.forward(
    new Request('https://api.github.com/', { headers: { host: 'api.github.com' } }),
  );

  expect(response.status).toBe(403);
  expect(ctx.sent).toHaveLength(0);
});

test('an unreachable upstream is a 502, and is audited', async () => {
  const ctx = setupForwarder({
    fetch: () => Promise.reject(new Error('connect refused')),
  });

  const response = await ctx.forward(
    new Request('https://api.github.com/x', { headers: { host: 'api.github.com' } }),
  );

  expect(response.status).toBe(502);
  expect(ctx.audits[0]).toMatchObject({ status: 502, path: '/x' });
});

test('a test upstream gets the extra CA, never a switch that turns verification off', async () => {
  const ctx = setupForwarder({
    resolveUpstream: () => ({ origin: 'https://172.17.0.1:9443', ca: ['ROOT', 'TEST CA'] }),
  });

  await ctx.forward(
    new Request('https://api.github.com/x', { headers: { host: 'api.github.com' } }),
  );

  expect(ctx.sent[0]?.url).toBe('https://172.17.0.1:9443/x');
  expect(ctx.sent[0]?.init.tls).toEqual({ ca: ['ROOT', 'TEST CA'] });
});

test('a websocket upgrade is answered 426 without a credential lookup or an upstream request', async () => {
  const lookups: string[] = [];

  const ctx = setupForwarder({
    findCredential: (impId, host) => {
      lookups.push(`${impId} ${host}`);

      return Promise.resolve(null);
    },
  });

  for (const upgrade of ['websocket', 'WebSocket', 'h2c, websocket']) {
    const response = await ctx.forward(
      new Request('https://api.github.com/stream', {
        headers: { host: 'api.github.com', connection: 'Upgrade', upgrade },
      }),
    );

    const text = await response.text();

    expect(response.status).toBe(426);
    expect(text).toBe('websocket upgrades are not supported through the broker\n');
  }

  expect(lookups).toEqual([]);
  expect(ctx.sent).toEqual([]);
  expect(ctx.audits).toEqual([]);
});

test('another upgrade protocol is not answered 426', async () => {
  const ctx = setupForwarder();

  const response = await ctx.forward(
    new Request('https://api.github.com/x', {
      headers: { host: 'api.github.com', upgrade: 'h2c' },
    }),
  );

  expect(response.status).toBe(201);
});
