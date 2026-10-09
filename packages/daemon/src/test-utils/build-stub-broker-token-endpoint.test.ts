import { expect, test } from 'bun:test';
import { server } from '@imp/test-utils/mock-server';
import { buildStubBrokerTokenEndpoint } from './build-stub-broker-token-endpoint';

test('it answers an issued refresh token with its queued answer', async () => {
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  const response = await fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=fake-refresh-0',
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(body).toStrictEqual({ access_token: 'fake-access-1', expires_in: 3600 });
});

test('it answers invalid_grant once a refresh token has used its answers', async () => {
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1' });

  await fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    body: 'refresh_token=fake-refresh-0',
  });

  const second = await fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    body: 'refresh_token=fake-refresh-0',
  });

  const body: unknown = await second.json();

  expect(second.status).toBe(400);
  expect(body).toStrictEqual({ error: 'invalid_grant' });
});

test('it answers a refresh token in the order its answers were queued', async () => {
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1' });
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-2' });

  const first = await fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    body: 'refresh_token=fake-refresh-0',
  });

  const second = await fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    body: 'refresh_token=fake-refresh-0',
  });

  const answers: unknown = [await first.json(), await second.json()];

  expect(answers).toStrictEqual([
    { access_token: 'fake-access-1' },
    { access_token: 'fake-access-2' },
  ]);
});

test('it records a JSON request with the refresh token it carries', async () => {
  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  await fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: '{"refresh_token":"fake-refresh-0"}',
  });

  expect(endpoint.requests).toStrictEqual([
    {
      contentType: 'application/json',
      accept: 'application/json',
      body: '{"refresh_token":"fake-refresh-0"}',
      refreshToken: 'fake-refresh-0',
    },
  ]);
});
