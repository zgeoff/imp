import { expect, test } from 'bun:test';
import { server } from '@imp/test-utils/mock-server';
import { buildStubCloudflareApi } from './build-stub-cloudflare-api';

test('it lists the zones that have the name asked for', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com', name_servers: ['ns1.test'] });
  await api.zones.create({ id: 'z2', name: 'other.com' });

  const response = await fetch('https://api.cloudflare.com/client/v4/zones?name=example.com', {
    headers: { authorization: 'Bearer cf-token' },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    success: true,
    errors: [],
    messages: [],
    result: [{ id: 'z1', name: 'example.com', name_servers: ['ns1.test'] }],
    result_info: { page: 1, per_page: 20, count: 1, total_pages: 1 },
  });
});

test('it refuses a token it does not accept with Cloudflare’s 403', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const response = await fetch('https://api.cloudflare.com/client/v4/zones?name=example.com', {
    headers: { authorization: 'Bearer wrong-token' },
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(body).toStrictEqual({
    success: false,
    errors: [{ code: 9109, message: 'Invalid access token' }],
    messages: [],
    result: null,
  });
});

test('it creates a record and answers it with the fields left out filled', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const response = await fetch('https://api.cloudflare.com/client/v4/zones/z1/dns_records', {
    method: 'POST',
    headers: { authorization: 'Bearer cf-token', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'TXT', name: '_acme.example.com', content: 'v1', ttl: 60 }),
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    success: true,
    errors: [],
    messages: [],
    result: {
      id: expect.toSatisfy((id: string) => /^[0-9a-f]{32}$/v.test(id)),
      name: '_acme.example.com',
      type: 'TXT',
      content: 'v1',
      proxied: false,
      comment: null,
    },
  });
});

test('it refuses a record that has no content', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const response = await fetch('https://api.cloudflare.com/client/v4/zones/z1/dns_records', {
    method: 'POST',
    headers: { authorization: 'Bearer cf-token', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'A', name: 'a.example.com' }),
  });

  expect(response.status).toBe(400);
  expect(api.readRecords()).toStrictEqual([]);
});

test('it lists a zone’s records by type and exact name', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });
  await api.records.create({ id: 'r1', zone_id: 'z1', type: 'A', name: 'a.example.com' });
  await api.records.create({ id: 'r2', zone_id: 'z1', type: 'TXT', name: 'a.example.com' });
  await api.records.create({ id: 'r3', zone_id: 'z1', type: 'A', name: 'b.a.example.com' });
  await api.records.create({ id: 'r4', zone_id: 'z9', type: 'A', name: 'a.example.com' });

  const response = await fetch(
    'https://api.cloudflare.com/client/v4/zones/z1/dns_records?type=A&name=a.example.com',
    { headers: { authorization: 'Bearer cf-token' } },
  );

  const body: unknown = await response.json();

  expect(body).toMatchObject({ result: [{ id: 'r1' }] });
});

test('it lists a zone’s records by name suffix', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });
  await api.records.create({ id: 'r1', zone_id: 'z1', name: 'a.pub.example.com' });
  await api.records.create({ id: 'r2', zone_id: 'z1', name: 'pub.example.com' });

  const response = await fetch(
    'https://api.cloudflare.com/client/v4/zones/z1/dns_records?name.endswith=.pub.example.com',
    { headers: { authorization: 'Bearer cf-token' } },
  );

  const body: unknown = await response.json();

  expect(body).toMatchObject({ result: [{ id: 'r1' }] });
});

test('it pages a list by the page size asked for, and says how many pages there are', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });
  await api.records.create({ id: 'r1', zone_id: 'z1' });
  await api.records.create({ id: 'r2', zone_id: 'z1' });
  await api.records.create({ id: 'r3', zone_id: 'z1' });

  const response = await fetch(
    'https://api.cloudflare.com/client/v4/zones/z1/dns_records?per_page=2&page=2',
    { headers: { authorization: 'Bearer cf-token' } },
  );

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    result: [{ id: 'r3' }],
    result_info: { page: 2, per_page: 2, count: 1, total_count: 3, total_pages: 2 },
  });
});

test('it serves fewer records a page than asked for when given a smaller page', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'], maxPerPage: 1 });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });
  await api.records.create({ id: 'r1', zone_id: 'z1' });
  await api.records.create({ id: 'r2', zone_id: 'z1' });

  const response = await fetch(
    'https://api.cloudflare.com/client/v4/zones/z1/dns_records?per_page=500&page=1',
    { headers: { authorization: 'Bearer cf-token' } },
  );

  const body: unknown = await response.json();

  expect(body).toMatchObject({ result: [{ id: 'r1' }] });
});

test('it leaves result_info off a list when told to', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'], hasResultInfo: false });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const response = await fetch('https://api.cloudflare.com/client/v4/zones/z1/dns_records', {
    headers: { authorization: 'Bearer cf-token' },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ success: true, errors: [], messages: [], result: [] });
});

test('it answers 404 for the records of a zone it does not hold', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const response = await fetch('https://api.cloudflare.com/client/v4/zones/z9/dns_records', {
    headers: { authorization: 'Bearer cf-token' },
  });

  expect(response.status).toBe(404);
});

test('it overwrites a record in place', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });
  await api.records.create({ id: 'r1', zone_id: 'z1', content: '192.0.2.1', proxied: true });

  await fetch('https://api.cloudflare.com/client/v4/zones/z1/dns_records/r1', {
    method: 'PUT',
    headers: { authorization: 'Bearer cf-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'A',
      name: 'a.example.com',
      content: '192.0.2.2',
      ttl: 300,
      comment: 'mine',
    }),
  });

  expect(api.readRecords()).toStrictEqual([
    {
      id: 'r1',
      zone_id: 'z1',
      type: 'A',
      name: 'a.example.com',
      content: '192.0.2.2',
      ttl: 300,
      proxied: false,
      comment: 'mine',
    },
  ]);
});

test('it answers 404 for an overwrite of a record it does not hold', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const response = await fetch('https://api.cloudflare.com/client/v4/zones/z1/dns_records/r9', {
    method: 'PUT',
    headers: { authorization: 'Bearer cf-token', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'A', name: 'a.example.com', content: '192.0.2.2' }),
  });

  expect(response.status).toBe(404);
});

test('it deletes a record and answers its id', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });
  await api.records.create({ id: 'r1', zone_id: 'z1' });

  const response = await fetch('https://api.cloudflare.com/client/v4/zones/z1/dns_records/r1', {
    method: 'DELETE',
    headers: { authorization: 'Bearer cf-token' },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ success: true, errors: [], messages: [], result: { id: 'r1' } });
  expect(api.readRecords()).toStrictEqual([]);
});

test('it answers Cloudflare’s 404 for a delete of a record it does not hold', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const response = await fetch('https://api.cloudflare.com/client/v4/zones/z1/dns_records/r9', {
    method: 'DELETE',
    headers: { authorization: 'Bearer cf-token' },
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(404);

  expect(body).toStrictEqual({
    success: false,
    errors: [{ code: 81_044, message: 'Record does not exist.' }],
    messages: [],
    result: null,
  });
});

test('it records each call with its path and token', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await fetch('https://api.cloudflare.com/client/v4/zones?name=example.com', {
    headers: { authorization: 'Bearer wrong-token' },
  });

  expect(api.requests).toStrictEqual([
    { method: 'GET', path: '/zones?name=example.com', token: 'wrong-token' },
  ]);
});
