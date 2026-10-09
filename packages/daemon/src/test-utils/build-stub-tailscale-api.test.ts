import { expect, test } from 'bun:test';
import { server } from '@imp/test-utils/mock-server';
import { z } from 'zod';
import { buildStubTailscaleApi } from './build-stub-tailscale-api';

test('it hands an access token to its client by client credentials', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  const response = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'kExample',
      client_secret: 'secret',
      grant_type: 'client_credentials',
      scope: 'services',
    }),
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(200);

  expect(body).toStrictEqual({
    access_token: expect.toStartWith('tskey-api-'),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'services',
  });
});

test('it refuses a token to another client with a 401', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  const response = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'kExample',
      client_secret: 'wrong',
      grant_type: 'client_credentials',
    }),
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(401);
  expect(body).toStrictEqual({ message: 'invalid client credentials' });
});

test('it answers 401 to a services call with no token it issued', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  const response = await fetch('https://api.tailscale.com/api/v2/tailnet/-/services', {
    headers: { authorization: 'Bearer tskey-api-made-up' },
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(401);
  expect(body).toStrictEqual({ message: 'invalid token' });
});

test('it answers 401 to a token once the tokens are revoked', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  const issued = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'kExample',
      client_secret: 'secret',
      grant_type: 'client_credentials',
    }),
  });

  const answer: unknown = await issued.json();

  const token = z.object({ access_token: z.string() }).parse(answer).access_token;

  api.revokeTokens();

  const response = await fetch('https://api.tailscale.com/api/v2/tailnet/-/services', {
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.status).toBe(401);
});

test('it lists the stored services as vipServices', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  await api.services.create({ name: 'svc:box', comment: 'imp host a', tags: ['tag:imp-svc'] });

  const issued = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'kExample',
      client_secret: 'secret',
      grant_type: 'client_credentials',
    }),
  });

  const answer: unknown = await issued.json();

  const token = z.object({ access_token: z.string() }).parse(answer).access_token;

  const response = await fetch('https://api.tailscale.com/api/v2/tailnet/-/services', {
    headers: { authorization: `Bearer ${token}` },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    vipServices: [
      {
        name: 'svc:box',
        comment: 'imp host a',
        ports: ['tcp:80', 'tcp:443'],
        tags: ['tag:imp-svc'],
      },
    ],
  });
});

test('it stores a service a PUT writes under its encoded name', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  const issued = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'kExample',
      client_secret: 'secret',
      grant_type: 'client_credentials',
    }),
  });

  const answer: unknown = await issued.json();

  const token = z.object({ access_token: z.string() }).parse(answer).access_token;

  await fetch('https://api.tailscale.com/api/v2/tailnet/-/services/svc%3Abox', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'svc:box', comment: 'c', ports: ['tcp:80'], tags: [] }),
  });

  const stored: unknown[] = api.services.all();

  expect(stored).toStrictEqual([{ name: 'svc:box', comment: 'c', ports: ['tcp:80'], tags: [] }]);
});

test('it answers 404 with a message to a read of a service it does not hold', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  const issued = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'kExample',
      client_secret: 'secret',
      grant_type: 'client_credentials',
    }),
  });

  const answer: unknown = await issued.json();

  const token = z.object({ access_token: z.string() }).parse(answer).access_token;

  const response = await fetch('https://api.tailscale.com/api/v2/tailnet/-/services/svc%3Anone', {
    headers: { authorization: `Bearer ${token}` },
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(404);
  expect(body).toStrictEqual({ message: 'not found' });
});

test('it answers 404 to a delete of a service it does not hold', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  const issued = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'kExample',
      client_secret: 'secret',
      grant_type: 'client_credentials',
    }),
  });

  const answer: unknown = await issued.json();

  const token = z.object({ access_token: z.string() }).parse(answer).access_token;

  const response = await fetch('https://api.tailscale.com/api/v2/tailnet/-/services/svc%3Anone', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.status).toBe(404);
});

test('it removes a service a DELETE names', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  await api.services.create({ name: 'svc:box' });

  const issued = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'kExample',
      client_secret: 'secret',
      grant_type: 'client_credentials',
    }),
  });

  const answer: unknown = await issued.json();

  const token = z.object({ access_token: z.string() }).parse(answer).access_token;

  const response = await fetch('https://api.tailscale.com/api/v2/tailnet/-/services/svc%3Abox', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.status).toBe(200);
  expect(api.services.count()).toBe(0);
});

test('it records each request with its method, path as sent and authorization', async () => {
  const api = buildStubTailscaleApi({ client: { clientId: 'kExample', clientSecret: 'secret' } });

  server.use(...api.handlers);

  await fetch('https://api.tailscale.com/api/v2/tailnet/-/services/svc%3Abox', {
    headers: { authorization: 'Bearer none' },
  });

  expect(api.requests).toStrictEqual([
    {
      method: 'GET',
      path: '/tailnet/-/services/svc%3Abox',
      authorization: 'Bearer none',
      body: '',
    },
  ]);
});
