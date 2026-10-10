import { expect, mock, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { server } from '@imp/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { buildStubTailscaleApi } from '../test-utils/build-stub-tailscale-api';
import { createServicesApi } from './services-api';

test('it asks for a token by client credentials, with the services scope only', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  await api.listServices();

  expect(Object.fromEntries(new URLSearchParams(stub.requests[0]?.body))).toStrictEqual({
    client_id: 'kExample',
    client_secret: 'secret',
    grant_type: 'client_credentials',
    scope: 'services',
  });
});

test('it sends the token it was given as a bearer token', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  await api.listServices();

  const [token] = stub.readIssuedTokens();

  invariant(token);

  expect(stub.requests.at(-1)?.authorization).toBe(`Bearer ${token}`);
});

test('it keeps one token for calls before its last minute', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const clock = { now: 0 };

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
    now: () => clock.now,
  });

  await api.listServices();

  clock.now = 3_600_000 - 60_001;

  await api.listServices();

  expect(stub.requests.filter((request) => request.path === '/oauth/token')).toHaveLength(1);
});

test('it asks for a new token in the old one’s last minute', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const clock = { now: 0 };

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
    now: () => clock.now,
  });

  await api.listServices();

  clock.now = 3_600_000 - 30_000;

  await api.listServices();

  expect(stub.requests.filter((request) => request.path === '/oauth/token')).toHaveLength(2);
});

test('it rejects with the token endpoint’s status and message when the client is refused', () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'rotated-away' }),
  });

  expect(api.listServices()).rejects.toMatchObject({
    name: 'TailscaleApiError',
    status: 401,
    message: 'Tailscale OAuth token: 401 invalid client credentials',
  });
});

test('it lists the tailnet’s services', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  await stub.services.create({
    name: 'svc:box',
    comment: 'imp host abc',
    ports: ['tcp:80', 'tcp:443'],
    tags: ['tag:imp-svc'],
  });

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  const listed = await api.listServices();

  expect(listed).toStrictEqual([
    {
      name: 'svc:box',
      comment: 'imp host abc',
      ports: ['tcp:80', 'tcp:443'],
      tags: ['tag:imp-svc'],
    },
  ]);
});

test('it lists no services when the API answers a null list', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(
    http.get('https://api.tailscale.com/api/v2/tailnet/-/services', () =>
      HttpResponse.json({ vipServices: null }),
    ),
    ...stub.handlers,
  );

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  const listed = await api.listServices();

  expect(listed).toStrictEqual([]);
});

test('it stores the service it writes', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  await api.writeService({
    name: 'svc:box',
    comment: 'imp host abc',
    ports: ['tcp:80', 'tcp:443'],
    tags: ['tag:imp-svc'],
  });

  const stored: unknown[] = stub.services.all();

  expect(stored).toStrictEqual([
    {
      name: 'svc:box',
      comment: 'imp host abc',
      ports: ['tcp:80', 'tcp:443'],
      tags: ['tag:imp-svc'],
    },
  ]);
});

test('it sends a write to the encoded service path', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  await api.writeService({ name: 'svc:box', comment: '', ports: [], tags: [] });

  expect(stub.requests.at(-1)).toMatchObject({
    method: 'PUT',
    path: '/tailnet/-/services/svc%3Abox',
  });
});

test('it reads a service by name', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  await stub.services.create({ name: 'svc:box', comment: 'imp host abc', tags: ['tag:imp-svc'] });

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  const read = await api.readService('svc:box');

  expect(read).toStrictEqual({
    name: 'svc:box',
    comment: 'imp host abc',
    ports: ['tcp:80', 'tcp:443'],
    tags: ['tag:imp-svc'],
  });
});

test('it reads a service the API does not have as null', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  const read = await api.readService('svc:box');

  expect(read).toBeNull();
});

test('it rejects a read the API fails with anything but 404', () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(
    http.get('https://api.tailscale.com/api/v2/tailnet/-/services/:name', () =>
      HttpResponse.json({ message: 'internal error' }, { status: 500 }),
    ),
    ...stub.handlers,
  );

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  expect(api.readService('svc:box')).rejects.toMatchObject({
    name: 'TailscaleApiError',
    status: 500,
    message: 'Tailscale GET /tailnet/-/services/svc%3Abox: 500 internal error',
  });
});

test('it deletes a service by name', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  await stub.services.create({ name: 'svc:box' });

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  await api.deleteService('svc:box');

  expect(stub.services.count()).toBe(0);
});

test('it counts a delete of a service that is already gone as done', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  await expect(api.deleteService('svc:box')).toResolve();
});

test('it rejects a delete the API fails with anything but 404', () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(
    http.delete('https://api.tailscale.com/api/v2/tailnet/-/services/:name', () =>
      HttpResponse.json({ message: 'forbidden' }, { status: 403 }),
    ),
    ...stub.handlers,
  );

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  expect(api.deleteService('svc:box')).rejects.toMatchObject({
    name: 'TailscaleApiError',
    status: 403,
    message: 'Tailscale DELETE /tailnet/-/services/svc%3Abox: 403 forbidden',
  });
});

test('it rejects a call whose token the API refuses with a 401', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  await api.listServices();

  stub.revokeTokens();

  expect(api.listServices()).rejects.toMatchObject({
    name: 'TailscaleApiError',
    status: 401,
    message: 'Tailscale GET /tailnet/-/services: 401 invalid token',
  });
});

test('it asks for a new token on the call after a 401', async () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...stub.handlers);

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  await api.listServices();

  stub.revokeTokens();

  // the fault: the call with the revoked token is refused and drops it
  const [refused] = await Promise.allSettled([api.listServices()]);
  const listed = await api.listServices();

  expect(refused).toMatchObject({ status: 'rejected', reason: { status: 401 } });
  expect(listed).toStrictEqual([]);
  expect(stub.requests.filter((request) => request.path === '/oauth/token')).toHaveLength(2);
});

test('it keeps the client secret and the token out of an API error', async () => {
  const stub = buildStubTailscaleApi({
    client: { clientId: 'kExample', clientSecret: 'tskey-client-kExample-SECRETVALUE' },
  });

  const authorized = mock<(authorization: string | null) => void>();

  server.use(
    http.put('https://api.tailscale.com/api/v2/tailnet/-/services/:name', (info) => {
      authorized(info.request.headers.get('authorization'));

      return HttpResponse.json({ message: 'name already in use by a machine' }, { status: 400 });
    }),
    ...stub.handlers,
  );

  const api = createServicesApi({
    readCredential: () => ({
      clientId: 'kExample',
      clientSecret: 'tskey-client-kExample-SECRETVALUE',
    }),
  });

  const [settled] = await Promise.allSettled([
    api.writeService({ name: 'svc:box', comment: '', ports: [], tags: [] }),
  ]);

  const token = authorized.mock.calls[0]?.[0]?.replace('Bearer ', '');

  if (settled?.status !== 'rejected') {
    throw new Error('the write was not refused');
  }

  invariant(token);

  expect(String(settled.reason)).toBe(
    'TailscaleApiError: Tailscale PUT /tailnet/-/services/svc%3Abox: 400 name already in use by a machine',
  );

  expect(String(settled.reason)).not.toInclude('SECRETVALUE');
  expect(String(settled.reason)).not.toInclude(token);
});

test('it puts the start of a body that is not Tailscale’s JSON into the error', () => {
  const stub = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(
    http.get('https://api.tailscale.com/api/v2/tailnet/-/services', () =>
      HttpResponse.text(`<html>${'x'.repeat(300)}</html>`, { status: 502 }),
    ),
    ...stub.handlers,
  );

  const api = createServicesApi({
    readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
  });

  expect(api.listServices()).rejects.toThrowWithMessage(
    Error,
    `Tailscale GET /tailnet/-/services: 502 <html>${'x'.repeat(194)}`,
  );
});
