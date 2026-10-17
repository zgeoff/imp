import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { server } from '@impz/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import invariant from 'tiny-invariant';
import type { NewAuditEntry } from '../db/broker-audit';
import { buildMockCredential } from '../test-utils/build-mock-credential';
import { startStubBrokerTlsUpstream } from '../test-utils/start-stub-broker-tls-upstream';
import { loadOrCreateBrokerCa } from './broker-ca';
import { createForwarder } from './forward-request';

// the stand-in TLS upstreams keep their CAs here, and stop before it goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'forward-request-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { stack, dir };
}

test('it sends the path and query to the bound host with the method and body', async () => {
  const received = mock<(sent: Readonly<{ url: string; method: string; body: string }>) => void>();

  server.use(
    http.post('https://api.github.com/repos/a/b', async (info) => {
      received({
        url: info.request.url,
        method: info.request.method,
        body: await info.request.text(),
      });

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  await forward(
    new Request('https://api.github.com/repos/a/b?token=secret', {
      method: 'POST',
      headers: { host: 'api.github.com' },
      body: 'payload',
    }),
  );

  expect(received).toHaveBeenCalledExactlyOnceWith({
    url: 'https://api.github.com/repos/a/b?token=secret',
    method: 'POST',
    body: 'payload',
  });
});

test('it sends the real credential in place of the guest placeholder', async () => {
  const received = mock<(authorization: string | null) => void>();

  server.use(
    http.get('https://api.github.com/user', (info) => {
      received(info.request.headers.get('authorization'));

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  await forward(
    new Request('https://api.github.com/user', {
      headers: { host: 'api.github.com', authorization: 'Bearer imp-broker-placeholder' },
    }),
  );

  expect(received).toHaveBeenCalledExactlyOnceWith('Bearer real');
});

test('it drops hop-by-hop headers and the ones Connection names, and keeps the rest', async () => {
  const received = mock<(headers: Readonly<Record<string, string | null>>) => void>();

  server.use(
    http.get('https://api.github.com/user', (info) => {
      received({
        'proxy-authorization': info.request.headers.get('proxy-authorization'),
        connection: info.request.headers.get('connection'),
        'x-drop': info.request.headers.get('x-drop'),
        'x-keep': info.request.headers.get('x-keep'),
      });

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  await forward(
    new Request('https://api.github.com/user', {
      headers: {
        host: 'api.github.com',
        'proxy-authorization': 'Basic x',
        connection: 'keep-alive, x-drop',
        'x-drop': '1',
        'x-keep': '1',
      },
    }),
  );

  expect(received).toHaveBeenCalledExactlyOnceWith({
    'proxy-authorization': null,
    connection: null,
    'x-drop': null,
    'x-keep': '1',
  });
});

test('it answers with the upstream status and end-to-end headers, the encoding included', async () => {
  server.use(
    http.get(
      'https://api.github.com/user',
      () =>
        new HttpResponse(Bun.gzipSync(Buffer.from('upstream body')), {
          status: 201,
          headers: { 'content-encoding': 'gzip', 'x-up': '1', 'x-gone': '1', connection: 'x-gone' },
        }),
    ),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/user', { headers: { host: 'api.github.com' } }),
  );

  expect(response.status).toBe(201);
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(response.headers.get('x-up')).toBe('1');
  expect(response.headers.get('x-gone')).toBeNull();
  expect(response.headers.get('connection')).toBeNull();
});

test('it records an audit row with the path without its query and the bytes each way', async () => {
  const audits: NewAuditEntry[] = [];

  server.use(
    http.post('https://api.github.com/repos/a/b', async (info) => {
      await info.request.text();

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: (entry) => {
      audits.push(entry);
    },
  });

  const response = await forward(
    new Request('https://api.github.com/repos/a/b?token=secret', {
      method: 'POST',
      headers: { host: 'api.github.com' },
      body: 'payload',
    }),
  );

  await response.text();

  expect(audits).toStrictEqual([
    {
      impId: 'imp-1',
      secretName: 'gh',
      at: expect.toBeValidDate(),
      method: 'POST',
      host: 'api.github.com',
      path: '/repos/a/b',
      status: 200,
      requestBytes: 'payload'.length,
      responseBytes: 'upstream body'.length,
      durationMs: expect.toBeNumber(),
      reason: null,
    },
  ]);
});

test('it cuts the audit row path at 512 characters', async () => {
  const audits: NewAuditEntry[] = [];
  const path = `/${'a'.repeat(600)}`;

  server.use(http.get(`https://api.github.com${path}`, () => HttpResponse.text('upstream body')));

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: (entry) => {
      audits.push(entry);
    },
  });

  const response = await forward(
    new Request(`https://api.github.com${path}`, { headers: { host: 'api.github.com' } }),
  );

  await response.text();

  expect(audits.map((entry) => entry.path)).toStrictEqual([path.slice(0, 512)]);
});

test('it records an audit row for an answer with no body', async () => {
  const audits: NewAuditEntry[] = [];

  server.use(
    http.get('https://api.github.com/none', () => new HttpResponse(null, { status: 204 })),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: (entry) => {
      audits.push(entry);
    },
  });

  await forward(
    new Request('https://api.github.com/none', { headers: { host: 'api.github.com' } }),
  );

  expect(audits).toStrictEqual([
    {
      impId: 'imp-1',
      secretName: 'gh',
      at: expect.toBeValidDate(),
      method: 'GET',
      host: 'api.github.com',
      path: '/none',
      status: 204,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: expect.toBeNumber(),
      reason: null,
    },
  ]);
});

test('it records an audit row when the upstream body fails midway', async () => {
  const audits: NewAuditEntry[] = [];

  // the upstream fails only once the guest has read its first chunk
  const firstRead = Promise.withResolvers<void>();

  server.use(
    http.get(
      'https://api.github.com/big',
      () =>
        new HttpResponse(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode('first'));
            },
            pull: async (controller) => {
              await firstRead.promise;

              controller.error(new Error('upstream reset'));
            },
          }),
        ),
    ),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: (entry) => {
      audits.push(entry);
    },
  });

  const response = await forward(
    new Request('https://api.github.com/big', { headers: { host: 'api.github.com' } }),
  );

  invariant(response.body);

  const reader = response.body.getReader();

  await reader.read();

  firstRead.resolve();

  expect(reader.read()).rejects.toThrow('upstream reset');

  expect(audits).toStrictEqual([
    {
      impId: 'imp-1',
      secretName: 'gh',
      at: expect.toBeValidDate(),
      method: 'GET',
      host: 'api.github.com',
      path: '/big',
      status: 200,
      requestBytes: 0,
      responseBytes: 'first'.length,
      durationMs: expect.toBeNumber(),
      reason: null,
    },
  ]);
});

test('it records an audit row with the bytes read when the guest hangs up mid-body', async () => {
  const audits: NewAuditEntry[] = [];

  server.use(
    http.get(
      'https://api.github.com/slow',
      () =>
        new HttpResponse(
          new ReadableStream<Uint8Array>({
            pull: (controller) => {
              controller.enqueue(new TextEncoder().encode('first'));
            },
          }),
        ),
    ),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: (entry) => {
      audits.push(entry);
    },
  });

  const response = await forward(
    new Request('https://api.github.com/slow', { headers: { host: 'api.github.com' } }),
  );

  invariant(response.body);

  const reader = response.body.getReader();

  await reader.read();

  // the mocked upstream never settles a cancel, so the test does not wait on it
  void reader.cancel();

  expect(audits).toStrictEqual([
    {
      impId: 'imp-1',
      secretName: 'gh',
      at: expect.toBeValidDate(),
      method: 'GET',
      host: 'api.github.com',
      path: '/slow',
      status: 200,
      requestBytes: 0,
      responseBytes: 'first'.length,
      durationMs: expect.toBeNumber(),
      reason: null,
    },
  ]);
});

test('it refuses a Host header for another name with 421', async () => {
  const reached = mock<(url: string) => void>();

  server.use(
    http.all('*', (info) => {
      reached(info.request.url);

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://evil.test/x', { headers: { host: 'evil.test' } }),
  );

  const text = await response.text();

  expect(response.status).toBe(421);
  expect(text).toBe('this connection is for api.github.com\n');
  expect(reached).not.toHaveBeenCalled();
});

test('it refuses a request with no Host header with 421', async () => {
  const reached = mock<(url: string) => void>();

  server.use(
    http.all('*', (info) => {
      reached(info.request.url);

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  const response = await forward(new Request('https://api.github.com/x'));
  const text = await response.text();

  expect(response.status).toBe(421);
  expect(text).toBe('this connection is for api.github.com\n');
  expect(reached).not.toHaveBeenCalled();
});

test('it sends an absolute-form target for another host to the bound host', async () => {
  const received = mock<(url: string) => void>();

  server.use(
    http.get('https://api.github.com/steal', (info) => {
      received(info.request.url);

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  await forward(
    new Request('https://evil.test/steal', { headers: { host: 'API.github.com:443' } }),
  );

  expect(received).toHaveBeenCalledExactlyOnceWith('https://api.github.com/steal');
});

test('it refuses a request with 403 once the grant is gone', async () => {
  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () => Promise.resolve(null),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/', { headers: { host: 'api.github.com' } }),
  );

  const text = await response.text();

  expect(response.status).toBe(403);
  expect(text).toBe('no credential is granted for api.github.com\n');
});

test('it answers 502 when the upstream cannot be reached', async () => {
  server.use(http.get('https://api.github.com/x', () => HttpResponse.error()));

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/x', { headers: { host: 'api.github.com' } }),
  );

  const text = await response.text();

  expect(response.status).toBe(502);
  expect(text).toBe('could not reach api.github.com\n');
});

test('it records a 502 audit row when the upstream cannot be reached', async () => {
  const audits: NewAuditEntry[] = [];

  server.use(http.get('https://api.github.com/x', () => HttpResponse.error()));

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: (entry) => {
      audits.push(entry);
    },
  });

  await forward(new Request('https://api.github.com/x', { headers: { host: 'api.github.com' } }));

  expect(audits).toStrictEqual([
    {
      impId: 'imp-1',
      secretName: 'gh',
      at: expect.toBeValidDate(),
      method: 'GET',
      host: 'api.github.com',
      path: '/x',
      status: 502,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: expect.toBeNumber(),
      reason: null,
    },
  ]);
});

test('it sends a host with a test upstream to the test origin', async () => {
  const received = mock<(url: string) => void>();

  server.use(
    http.get('https://upstream.test:9443/x', (info) => {
      received(info.request.url);

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: () => ({ origin: 'https://upstream.test:9443', ca: ['TEST CA'] }),
    recordAudit: () => {},
  });

  await forward(new Request('https://api.github.com/x', { headers: { host: 'api.github.com' } }));

  expect(received).toHaveBeenCalledExactlyOnceWith('https://upstream.test:9443/x');
});

test.each([['websocket'], ['WebSocket'], ['h2c, websocket']])(
  'it answers an upgrade to %s with 426',
  async (upgrade) => {
    const forward = createForwarder({
      impId: 'imp-1',
      host: 'api.github.com',
      findCredential: () =>
        Promise.resolve(
          buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
        ),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit: () => {},
    });

    const response = await forward(
      new Request('https://api.github.com/stream', {
        headers: { host: 'api.github.com', connection: 'Upgrade', upgrade },
      }),
    );

    const text = await response.text();

    expect(response.status).toBe(426);
    expect(text).toBe('websocket upgrades are not supported through the broker\n');
  },
);

test('it answers a websocket upgrade without a credential lookup', async () => {
  const findCredential = mock(() => Promise.resolve(null));

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential,
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  await forward(
    new Request('https://api.github.com/stream', {
      headers: { host: 'api.github.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  expect(findCredential).not.toHaveBeenCalled();
});

test('it records a refused audit row for a websocket upgrade', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () => Promise.resolve(null),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit,
  });

  await forward(
    new Request('https://api.github.com/stream?token=abc', {
      headers: { host: 'api.github.com', connection: 'Upgrade', upgrade: 'websocket' },
    }),
  );

  expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
    impId: 'imp-1',
    secretName: null,
    at: expect.toBeValidDate(),
    method: 'GET',
    host: 'api.github.com',
    path: '/stream',
    status: 426,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: expect.toBeNumber(),
    reason: 'websocket',
  });
});

test('it records a refused audit row for a Host header for another name', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () => Promise.resolve(buildMockCredential({ secretName: 'gh' })),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit,
  });

  await forward(new Request('https://evil.test/x', { headers: { host: 'evil.test' } }));

  expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
    impId: 'imp-1',
    secretName: null,
    at: expect.toBeValidDate(),
    method: 'GET',
    host: 'api.github.com',
    path: '/x',
    status: 421,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: expect.toBeNumber(),
    reason: 'wrong-host',
  });
});

test('it records a refused audit row with no secret, header or body once the grant is gone', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () => Promise.resolve(null),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit,
  });

  await forward(
    new Request('https://api.github.com/repos/x/issues?token=query-secret', {
      method: 'POST',
      headers: {
        host: 'api.github.com',
        authorization: 'Bearer imp-broker-placeholder',
        cookie: 'session=cookie-secret',
      },
      body: 'body-secret',
    }),
  );

  expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
    impId: 'imp-1',
    secretName: null,
    at: expect.toBeValidDate(),
    method: 'POST',
    host: 'api.github.com',
    path: '/repos/x/issues',
    status: 403,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: expect.toBeNumber(),
    reason: 'no-grant',
  });
});

test('it forwards an upgrade to another protocol', async () => {
  server.use(
    http.get('https://api.github.com/x', () => HttpResponse.text('upstream body', { status: 201 })),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/x', {
      headers: { host: 'api.github.com', upgrade: 'h2c' },
    }),
  );

  expect(response.status).toBe(201);
});

test('it sends the request to the rule’s upstream ahead of a test upstream, with the real credential', async () => {
  const received = mock<(sent: Readonly<{ url: string; authorization: string | null }>) => void>();

  server.use(
    http.get('http://172.17.0.1:18081/v1/vaults', (info) => {
      received({ url: info.request.url, authorization: info.request.headers.get('authorization') });

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'svc.imp.internal',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({
          secretName: 'op',
          header: 'authorization',
          value: 'Bearer real',
          upstream: 'http://172.17.0.1:18081',
        }),
      ),
    resolveUpstream: () => ({ origin: 'https://test.invalid', ca: ['test-ca'] }),
    recordAudit: () => {},
  });

  await forward(
    new Request('https://svc.imp.internal/v1/vaults?x=1', {
      headers: { host: 'svc.imp.internal', authorization: 'Bearer imp-broker-placeholder' },
    }),
  );

  expect(received).toHaveBeenCalledExactlyOnceWith({
    url: 'http://172.17.0.1:18081/v1/vaults?x=1',
    authorization: 'Bearer real',
  });
});

test('it records the guest host, not the rule upstream, in the audit row', async () => {
  const audits: NewAuditEntry[] = [];

  server.use(
    http.get('http://172.17.0.1:18081/v1/vaults', () => HttpResponse.text('upstream body')),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'svc.imp.internal',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({
          secretName: 'op',
          header: 'authorization',
          value: 'Bearer real',
          upstream: 'http://172.17.0.1:18081',
        }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: (entry) => {
      audits.push(entry);
    },
  });

  const response = await forward(
    new Request('https://svc.imp.internal/v1/vaults?x=1', {
      headers: { host: 'svc.imp.internal' },
    }),
  );

  await response.text();

  expect(audits).toStrictEqual([
    {
      impId: 'imp-1',
      secretName: 'op',
      at: expect.toBeValidDate(),
      method: 'GET',
      host: 'svc.imp.internal',
      path: '/v1/vaults',
      status: 200,
      requestBytes: 0,
      responseBytes: 'upstream body'.length,
      durationMs: expect.toBeNumber(),
      reason: null,
    },
  ]);
});

test('it forwards over TLS to a test upstream that the test CA signed', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    dir: ctx.dir,
    fetch: (request) => new Response(`saw ${request.headers.get('authorization') ?? 'none'}`),
  });

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: () => ({ origin: upstream.origin, ca: [upstream.caPem] }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/x', { headers: { host: 'api.github.com' } }),
  );

  const text = await response.text();

  expect(text).toBe('saw Bearer real');
});

test('it answers 502 for a test upstream whose certificate the test CA did not sign', async () => {
  const ctx = await setupTest();

  const reached = mock<(url: string) => void>();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    dir: ctx.dir,
    fetch: (request) => {
      reached(request.url);

      return new Response('reached');
    },
  });

  const other = await loadOrCreateBrokerCa(join(ctx.dir, 'other-ca'));

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: () => ({ origin: upstream.origin, ca: [other.certPem] }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/x', { headers: { host: 'api.github.com' } }),
  );

  expect(response.status).toBe(502);
  expect(reached).not.toHaveBeenCalled();
});

// a real upstream over the wire: interception would hide both what fetch
// puts in Host and whether it decompresses the answer
test('it sends the upstream its own authority as Host, not the guest’s', async () => {
  const ctx = await setupTest();

  const received = mock<(host: string | null) => void>();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    dir: ctx.dir,
    fetch: (request) => {
      received(request.headers.get('host'));

      return new Response('upstream body');
    },
  });

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: () => ({ origin: upstream.origin, ca: [upstream.caPem] }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/x', { headers: { host: 'api.github.com' } }),
  );

  await response.text();

  expect(received).toHaveBeenCalledExactlyOnceWith(`localhost:${String(upstream.port)}`);
});

test('it passes gzip bytes through unchanged, without decompressing them', async () => {
  const ctx = await setupTest();

  const gzipped = Bun.gzipSync(Buffer.from('upstream body'));

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    dir: ctx.dir,
    fetch: () => new Response(gzipped, { headers: { 'content-encoding': 'gzip' } }),
  });

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ secretName: 'gh', header: 'authorization', value: 'Bearer real' }),
      ),
    resolveUpstream: () => ({ origin: upstream.origin, ca: [upstream.caPem] }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/x', { headers: { host: 'api.github.com' } }),
  );

  const body = await response.arrayBuffer();

  expect(new Uint8Array(body)).toStrictEqual(new Uint8Array(gzipped));
});

test('it sends a request inside the grant’s filter with the real credential', async () => {
  const received =
    mock<(sent: Readonly<{ method: string; authorization: string | null }>) => void>();

  server.use(
    http.get('https://api.github.com/repos/a/b/issues', (info) => {
      received({
        method: info.request.method,
        authorization: info.request.headers.get('authorization'),
      });

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({
          secretName: 'gh',
          header: 'authorization',
          value: 'Bearer real',
          filter: { methods: ['GET', 'HEAD'], paths: ['/repos/*/*/issues'] },
        }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/repos/a/b/issues', {
      headers: { host: 'api.github.com', authorization: 'Bearer imp-broker-placeholder' },
    }),
  );

  expect(response.status).toBe(200);

  expect(received).toHaveBeenCalledExactlyOnceWith({
    method: 'GET',
    authorization: 'Bearer real',
  });
});

test('it refuses a method outside the grant’s filter with 403 and sends nothing upstream', async () => {
  const received = mock();

  server.use(
    http.all('https://api.github.com/*', () => {
      received();

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ filter: { methods: ['GET'], paths: ['/repos/*/*/issues'] } }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/repos/a/b/issues', {
      method: 'POST',
      headers: { host: 'api.github.com' },
      body: 'payload',
    }),
  );

  const text = await response.text();

  expect(response.status).toBe(403);
  expect(text).toBe('the grant for api.github.com does not cover POST /repos/a/b/issues\n');
  expect(received).not.toHaveBeenCalled();
});

test('it refuses a path outside the grant’s filter with 403 and sends nothing upstream', async () => {
  const received = mock();

  server.use(
    http.all('https://api.github.com/*', () => {
      received();

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(
        buildMockCredential({ filter: { methods: ['GET'], paths: ['/repos/*/*/issues'] } }),
      ),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  const response = await forward(
    new Request('https://api.github.com/repos/a/b/collaborators', {
      headers: { host: 'api.github.com' },
    }),
  );

  const text = await response.text();

  expect(response.status).toBe(403);
  expect(text).toBe('the grant for api.github.com does not cover GET /repos/a/b/collaborators\n');
  expect(received).not.toHaveBeenCalled();
});

test('it records a refused audit row with no secret, header or body for a request outside the filter', async () => {
  const recordAudit = mock<(entry: NewAuditEntry) => void>();

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () =>
      Promise.resolve(buildMockCredential({ secretName: 'gh', filter: { methods: ['GET'] } })),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit,
  });

  await forward(
    new Request('https://api.github.com/repos/x/issues?token=query-secret', {
      method: 'DELETE',
      headers: {
        host: 'api.github.com',
        authorization: 'Bearer imp-broker-placeholder',
        cookie: 'session=cookie-secret',
      },
    }),
  );

  expect(recordAudit).toHaveBeenCalledExactlyOnceWith({
    impId: 'imp-1',
    secretName: null,
    at: expect.toBeValidDate(),
    method: 'DELETE',
    host: 'api.github.com',
    path: '/repos/x/issues',
    status: 403,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: expect.toBeNumber(),
    reason: 'outside-filter',
  });
});

test.each([['X-HTTP-Method-Override'], ['X-HTTP-Method'], ['X-Method-Override']])(
  'it runs an allowed POST carrying %s: DELETE as a POST at an upstream that honours it',
  async (header) => {
    const received = mock<(method: string) => void>();

    // an upstream that runs the method the override header names, as some
    // frameworks do for a POST
    server.use(
      http.all('https://api.anthropic.com/v1/messages', (info) => {
        received(info.request.headers.get(header) ?? info.request.method);

        return HttpResponse.text('upstream body');
      }),
    );

    const forward = createForwarder({
      impId: 'imp-1',
      host: 'api.anthropic.com',
      findCredential: () =>
        Promise.resolve(
          buildMockCredential({ filter: { methods: ['POST'], paths: ['/v1/messages'] } }),
        ),
      resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
      recordAudit: () => {},
    });

    const response = await forward(
      new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { host: 'api.anthropic.com', [header]: 'DELETE' },
        body: 'payload',
      }),
    );

    expect(response.status).toBe(200);
    expect(received).toHaveBeenCalledExactlyOnceWith('POST');
  },
);

test('it sends a method-override header on a grant with no filter', async () => {
  const received = mock<(override: string | null) => void>();

  server.use(
    http.post('https://api.anthropic.com/v1/messages', (info) => {
      received(info.request.headers.get('x-http-method-override'));

      return HttpResponse.text('upstream body');
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.anthropic.com',
    findCredential: () => Promise.resolve(buildMockCredential({ filter: null })),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
  });

  await forward(
    new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { host: 'api.anthropic.com', 'x-http-method-override': 'PATCH' },
      body: 'payload',
    }),
  );

  expect(received).toHaveBeenCalledExactlyOnceWith('PATCH');
});

test('it sends a request without a body again when the body of the 401 fails', async () => {
  const answers = buildStubAnswerQueue([
    () =>
      new HttpResponse(
        new ReadableStream({
          pull: (controller) => {
            controller.error(new Error('the upstream hung up'));
          },
        }),
        { status: 401 },
      ),
    () => HttpResponse.text('models'),
  ]);

  const credentials = buildStubAnswerQueue([
    buildMockCredential({ secretName: 'codex', oauth: { refreshedAt: 1000 } }),
    buildMockCredential({ secretName: 'codex', oauth: { refreshedAt: 2000 } }),
  ]);

  server.use(http.get('https://chatgpt.com/backend-api/codex/models', () => answers.next()()));

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'chatgpt.com',
    findCredential: () => Promise.resolve(credentials.next()),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
    refreshAfterRejection: () => Promise.resolve(true),
  });

  const response = await forward(
    new Request('https://chatgpt.com/backend-api/codex/models', {
      headers: { host: 'chatgpt.com' },
    }),
  );

  expect(response.status).toBe(200);
});

test('it sends a request without a body again with the new oauth token after a 401', async () => {
  const received = mock<(authorization: string | null) => void>();
  const statuses = buildStubAnswerQueue([401, 200]);

  const credentials = buildStubAnswerQueue([
    buildMockCredential({
      secretName: 'codex',
      value: 'Bearer old',
      oauth: { refreshedAt: 1000 },
    }),
    buildMockCredential({
      secretName: 'codex',
      value: 'Bearer new',
      oauth: { refreshedAt: 2000 },
    }),
  ]);

  server.use(
    http.get('https://chatgpt.com/backend-api/codex/models', (info) => {
      received(info.request.headers.get('authorization'));

      return HttpResponse.text('models', { status: statuses.next() });
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'chatgpt.com',
    findCredential: () => Promise.resolve(credentials.next()),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
    refreshAfterRejection: () => Promise.resolve(true),
  });

  const response = await forward(
    new Request('https://chatgpt.com/backend-api/codex/models', {
      headers: { host: 'chatgpt.com' },
    }),
  );

  expect(response.status).toBe(200);
  expect(received.mock.calls).toStrictEqual([['Bearer old'], ['Bearer new']]);
});

test('it asks for a refresh of the rejected token by its secret and refresh time', async () => {
  const refreshAfterRejection = mock(() => Promise.resolve(false));

  server.use(
    http.get('https://chatgpt.com/backend-api/codex/models', () =>
      HttpResponse.text('expired', { status: 401 }),
    ),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'chatgpt.com',
    findCredential: () =>
      Promise.resolve(buildMockCredential({ secretName: 'codex', oauth: { refreshedAt: 1000 } })),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
    refreshAfterRejection,
  });

  await forward(
    new Request('https://chatgpt.com/backend-api/codex/models', {
      headers: { host: 'chatgpt.com' },
    }),
  );

  expect(refreshAfterRejection).toHaveBeenCalledExactlyOnceWith('codex', 1000);
});

test('it records an audit row for the rejected send and one for the send again', async () => {
  const audits: NewAuditEntry[] = [];
  const statuses = buildStubAnswerQueue([401, 200]);

  const credentials = buildStubAnswerQueue([
    buildMockCredential({ secretName: 'codex', oauth: { refreshedAt: 1000 } }),
    buildMockCredential({ secretName: 'codex', oauth: { refreshedAt: 2000 } }),
  ]);

  server.use(
    http.get('https://chatgpt.com/backend-api/codex/models', () =>
      HttpResponse.text('models', { status: statuses.next() }),
    ),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'chatgpt.com',
    findCredential: () => Promise.resolve(credentials.next()),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: (entry) => {
      audits.push(entry);
    },
    refreshAfterRejection: () => Promise.resolve(true),
  });

  const response = await forward(
    new Request('https://chatgpt.com/backend-api/codex/models', {
      headers: { host: 'chatgpt.com' },
    }),
  );

  await response.text();

  expect(audits).toIncludeAllPartialMembers([
    { secretName: 'codex', path: '/backend-api/codex/models', status: 401 },
    { secretName: 'codex', path: '/backend-api/codex/models', status: 200 },
  ]);

  expect(audits).toHaveLength(2);
});

test('it answers the 401 of a request with a body and still asks for a refresh', async () => {
  const received = mock<(body: string) => void>();
  const refreshAfterRejection = mock(() => Promise.resolve(true));

  server.use(
    http.post('https://chatgpt.com/backend-api/codex/responses', async (info) => {
      const body = await info.request.text();

      received(body);

      return HttpResponse.text('expired', { status: 401 });
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'chatgpt.com',
    findCredential: () =>
      Promise.resolve(buildMockCredential({ secretName: 'codex', oauth: { refreshedAt: 1000 } })),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
    refreshAfterRejection,
  });

  const response = await forward(
    new Request('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { host: 'chatgpt.com' },
      body: 'payload',
    }),
  );

  expect(response.status).toBe(401);
  expect(received).toHaveBeenCalledExactlyOnceWith('payload');
  expect(refreshAfterRejection).toHaveBeenCalledOnce();
});

test('it answers the 401 when no new oauth token is in place', async () => {
  const received = mock<(authorization: string | null) => void>();

  server.use(
    http.get('https://chatgpt.com/backend-api/codex/models', (info) => {
      received(info.request.headers.get('authorization'));

      return HttpResponse.text('expired', { status: 401 });
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'chatgpt.com',
    findCredential: () =>
      Promise.resolve(buildMockCredential({ value: 'Bearer old', oauth: { refreshedAt: 1000 } })),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
    refreshAfterRejection: () => Promise.resolve(false),
  });

  const response = await forward(
    new Request('https://chatgpt.com/backend-api/codex/models', {
      headers: { host: 'chatgpt.com' },
    }),
  );

  expect(response.status).toBe(401);
  expect(received).toHaveBeenCalledExactlyOnceWith('Bearer old');
});

test('it answers the 401 when the grant is gone after the refresh', async () => {
  const received = mock<(authorization: string | null) => void>();

  const credentials = buildStubAnswerQueue([
    buildMockCredential({ value: 'Bearer old', oauth: { refreshedAt: 1000 } }),
    null,
  ]);

  server.use(
    http.get('https://chatgpt.com/backend-api/codex/models', (info) => {
      received(info.request.headers.get('authorization'));

      return HttpResponse.text('expired', { status: 401 });
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'chatgpt.com',
    findCredential: () => Promise.resolve(credentials.next()),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
    refreshAfterRejection: () => Promise.resolve(true),
  });

  const response = await forward(
    new Request('https://chatgpt.com/backend-api/codex/models', {
      headers: { host: 'chatgpt.com' },
    }),
  );

  expect(response.status).toBe(401);
  expect(received).toHaveBeenCalledExactlyOnceWith('Bearer old');
});

test('it answers the 401 when the new grant filter does not cover the request', async () => {
  const received = mock<(authorization: string | null) => void>();

  const credentials = buildStubAnswerQueue([
    buildMockCredential({ value: 'Bearer old', oauth: { refreshedAt: 1000 } }),
    buildMockCredential({
      value: 'Bearer new',
      oauth: { refreshedAt: 2000 },
      filter: { methods: ['POST'] },
    }),
  ]);

  server.use(
    http.get('https://chatgpt.com/backend-api/codex/models', (info) => {
      received(info.request.headers.get('authorization'));

      return HttpResponse.text('expired', { status: 401 });
    }),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'chatgpt.com',
    findCredential: () => Promise.resolve(credentials.next()),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
    refreshAfterRejection: () => Promise.resolve(true),
  });

  const response = await forward(
    new Request('https://chatgpt.com/backend-api/codex/models', {
      headers: { host: 'chatgpt.com' },
    }),
  );

  expect(response.status).toBe(401);
  expect(received).toHaveBeenCalledExactlyOnceWith('Bearer old');
});

test('it asks for no refresh after a 401 to a credential that is not oauth', async () => {
  const refreshAfterRejection = mock(() => Promise.resolve(true));

  server.use(
    http.get('https://api.github.com/user', () => HttpResponse.text('bad', { status: 401 })),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'api.github.com',
    findCredential: () => Promise.resolve(buildMockCredential({ oauth: null })),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
    refreshAfterRejection,
  });

  await forward(
    new Request('https://api.github.com/user', { headers: { host: 'api.github.com' } }),
  );

  expect(refreshAfterRejection).not.toHaveBeenCalled();
});

test.each([[403], [429]])('it asks for no refresh after a %d to an oauth token', async (status) => {
  const refreshAfterRejection = mock(() => Promise.resolve(true));

  server.use(
    http.get('https://chatgpt.com/backend-api/codex/models', () =>
      HttpResponse.text('no', { status }),
    ),
  );

  const forward = createForwarder({
    impId: 'imp-1',
    host: 'chatgpt.com',
    findCredential: () => Promise.resolve(buildMockCredential({ oauth: { refreshedAt: 1000 } })),
    resolveUpstream: (host) => ({ origin: `https://${host}`, ca: null }),
    recordAudit: () => {},
    refreshAfterRejection,
  });

  await forward(
    new Request('https://chatgpt.com/backend-api/codex/models', {
      headers: { host: 'chatgpt.com' },
    }),
  );

  expect(refreshAfterRejection).not.toHaveBeenCalled();
});
