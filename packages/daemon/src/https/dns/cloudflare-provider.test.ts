import { afterAll, expect, test } from 'bun:test';
import * as z from 'zod';
import { readErrorMessage } from '../../read-error-message';
import { readRejection } from '../../read-rejection';
import { createCloudflareProvider } from './cloudflare-provider';
import { buildPublicOwner } from './dns-provider';

const TOKEN = 'cf-test-token-secret';

const RecordBodySchema = z.object({
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
  comment: z.string().optional(),
});

type FakeRecord = z.infer<typeof RecordBodySchema> & { id: string };

function buildReply(result: unknown, status = 200, resultInfo?: unknown): Response {
  return Response.json(
    { success: status < 400, errors: [], messages: [], result, result_info: resultInfo },
    { status },
  );
}

// Just enough of Cloudflare's v4 API: zones by name and DNS records.
function startFakeCloudflare() {
  const zones = [{ id: 'z1', name: 'example.com', name_servers: ['ns1.test', 'ns2.test'] }];
  const records: FakeRecord[] = [];
  const calls: string[] = [];
  let nextId = 1;

  // how the list pages: a cap below what was asked, and whether
  // result_info comes with it
  const paging = { cap: 100, hasResultInfo: true };

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      calls.push(`${request.method} ${url.pathname}${url.search}`);

      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json(
          { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] },
          { status: 403 },
        );
      }

      // /zones/<zone>/dns_records/<record>
      const recordId = url.pathname.split('/').at(4);

      if (!url.pathname.includes('/dns_records')) {
        return buildReply(zones.filter((zone) => zone.name === url.searchParams.get('name')));
      }

      if (request.method === 'GET') {
        const type = url.searchParams.get('type');
        const name = url.searchParams.get('name');
        const suffix = url.searchParams.get('name.endswith');
        const perPage = Math.min(paging.cap, Number(url.searchParams.get('per_page') ?? 100));
        const page = Number(url.searchParams.get('page') ?? 1);

        const found = records.filter(
          (record) =>
            (type === null || record.type === type) &&
            (name === null || record.name === name) &&
            (suffix === null || record.name.endsWith(suffix)),
        );

        const resultInfo = paging.hasResultInfo
          ? { page, total_pages: Math.ceil(found.length / perPage) }
          : undefined;

        return buildReply(found.slice((page - 1) * perPage, page * perPage), 200, resultInfo);
      }

      if (request.method === 'POST') {
        const json: unknown = await request.json();

        const body = RecordBodySchema.parse(json);
        const record = { id: `r${String(nextId)}`, ...body };

        nextId += 1;

        records.push(record);

        return buildReply(record);
      }

      const index = records.findIndex((record) => record.id === recordId);

      if (index === -1) {
        return buildReply(null, 404);
      }

      if (request.method === 'PUT') {
        const json: unknown = await request.json();

        const body = RecordBodySchema.parse(json);

        records[index] = { id: recordId ?? '', ...body };

        return buildReply(records[index]);
      }

      records.splice(index, 1);

      return buildReply({ id: recordId });
    },
  });

  return { server, records, calls, paging, url: `http://127.0.0.1:${String(server.port)}` };
}

const fake = startFakeCloudflare();

afterAll(async () => {
  await fake.server.stop(true);
});

function listContents(fqdn: string): string[] {
  return fake.records.filter((record) => record.name === fqdn).map((record) => record.content);
}

test('it adds two TXT values side by side and removes each by its id', async () => {
  const provider = createCloudflareProvider({ token: TOKEN, apiUrl: fake.url });
  const fqdn = '_acme-challenge.imp.example.com';

  const first = await provider.addTxt(fqdn, 'value-one');
  const second = await provider.addTxt(fqdn, 'value-two');

  expect(listContents(fqdn)).toEqual(['value-one', 'value-two']);

  await provider.removeTxt(first);

  expect(listContents(fqdn)).toEqual(['value-two']);

  await provider.removeTxt(second);

  expect(listContents(fqdn)).toEqual([]);
});

test('it finds the zone by walking up the labels, and asks once per name', async () => {
  const provider = createCloudflareProvider({ token: TOKEN, apiUrl: fake.url });

  fake.calls.length = 0;

  await provider.addTxt('_acme-challenge.deep.imp.example.com', 'v');
  await provider.addTxt('_acme-challenge.deep.imp.example.com', 'w');

  const zoneLookups = fake.calls.filter((call) => call.startsWith('GET /zones?'));

  expect(zoneLookups).toEqual([
    'GET /zones?name=_acme-challenge.deep.imp.example.com',
    'GET /zones?name=deep.imp.example.com',
    'GET /zones?name=imp.example.com',
    'GET /zones?name=example.com',
  ]);
});

test('it sets an A record DNS only and marked as its own, and changes it in place', async () => {
  const provider = createCloudflareProvider({ token: TOKEN, apiUrl: fake.url });

  fake.calls.length = 0;

  await provider.setA('*.imp.example.com', '100.64.0.7');

  expect(fake.calls.filter((call) => call.startsWith('GET /zones?'))).toEqual([
    'GET /zones?name=imp.example.com',
    'GET /zones?name=example.com',
  ]);

  for (const record of fake.records) {
    if (record.name === '*.imp.example.com') {
      record.proxied = true;
    }
  }

  await provider.setA('*.imp.example.com', '100.64.0.8');

  const records = fake.records.filter((record) => record.name === '*.imp.example.com');

  expect(records).toHaveLength(1);

  expect(records[0]).toMatchObject({
    type: 'A',
    content: '100.64.0.8',
    proxied: false,
    comment: 'managed by impd',
  });
});

test('it never replaces a record it did not make, and names it', async () => {
  const provider = createCloudflareProvider({ token: TOKEN, apiUrl: fake.url });

  // the zone apex, with a website on it
  fake.records.push({ id: 'web', type: 'A', name: 'example.com', content: '203.0.113.5' });

  const error = await readRejection(provider.setA('example.com', '100.64.0.7'));

  expect(readErrorMessage(error)).toContain(
    'example.com already has a record impd did not make (A 203.0.113.5)',
  );

  expect(fake.records.find((record) => record.id === 'web')?.content).toBe('203.0.113.5');
});

test('it warns when it finds more than one record of its own', async () => {
  const logs: string[] = [];

  const provider = createCloudflareProvider({
    token: TOKEN,
    apiUrl: fake.url,
    log: (message) => {
      logs.push(message);
    },
  });

  for (const id of ['a1', 'a2']) {
    fake.records.push({
      id,
      type: 'A',
      name: 'two.example.com',
      content: '100.64.0.1',
      comment: 'managed by impd',
    });
  }

  await provider.setA('two.example.com', '100.64.0.9');

  expect(logs).toEqual([
    'impd: https: warning: two.example.com has 2 A records impd made; it updates only the first',
  ]);
});

test('it lists and removes only its owner’s A records under the domain, page by page', async () => {
  const provider = createCloudflareProvider({ token: TOKEN, apiUrl: fake.url });
  const owner = buildPublicOwner('pub.example.com');
  const own = { type: 'A', comment: owner };

  fake.records.push(
    { id: 'p1', name: 'web.pub.example.com', content: '203.0.113.7', ...own },
    { id: 'p2', name: 'web.pub.example.com', content: '203.0.113.8', type: 'A' },
    { id: 'p3', name: 'pub.example.com', content: '100.64.0.7', ...own },
    { id: 'p4', name: 'other.example.com', content: '203.0.113.9', ...own },

    // the bare domain of an impd on dev.pub.example.com
    {
      id: 'p5',
      name: 'dev.pub.example.com',
      content: '100.64.0.8',
      type: 'A',
      comment: 'managed by impd',
    },
  );

  // more than a page of them
  for (let index = 0; index < 501; index += 1) {
    fake.records.push({
      id: `many${String(index)}`,
      name: `imp${String(index)}.pub.example.com`,
      content: '203.0.113.7',
      ...own,
    });
  }

  // pages of at most 100, counted by result_info
  const listed = await provider.listA('pub.example.com', owner);

  // pages as asked for, without result_info: it stops at the short page
  fake.paging.cap = Number.MAX_SAFE_INTEGER;
  fake.paging.hasResultInfo = false;

  const unpaged = await provider.listA('pub.example.com', owner);

  fake.paging.cap = 100;
  fake.paging.hasResultInfo = true;

  expect(unpaged).toEqual(listed);
  expect(listed.size).toBe(502);
  expect(listed.get('web.pub.example.com')).toBe('203.0.113.7');
  expect(listed.has('pub.example.com')).toBe(false);
  expect(listed.has('dev.pub.example.com')).toBe(false);

  await provider.removeA('web.pub.example.com', owner);
  await provider.removeA('dev.pub.example.com', owner);

  expect(fake.records.some((record) => record.id === 'p5')).toBe(true);

  // the record someone else made stays
  expect(fake.records.filter((record) => record.name === 'web.pub.example.com')).toEqual([
    { id: 'p2', name: 'web.pub.example.com', content: '203.0.113.8', type: 'A' },
  ]);
});

test('a bad token fails with the Cloudflare message, and the token is not in it', async () => {
  const provider = createCloudflareProvider({ token: 'wrong-secret', apiUrl: fake.url });

  const error = await readRejection(provider.addTxt('_acme-challenge.imp.example.com', 'v'));

  expect(readErrorMessage(error)).toContain('403 Invalid access token');
  expect(readErrorMessage(error)).not.toContain('wrong-secret');
});

test('a name in no zone the token sees is an error', async () => {
  const provider = createCloudflareProvider({ token: TOKEN, apiUrl: fake.url });

  const error = await readRejection(provider.setA('imp.other.org', '100.64.0.7'));

  expect(readErrorMessage(error)).toContain('no zone');
});

test('it waits for the TXT values on the zone nameservers', async () => {
  const asked: string[] = [];

  const provider = createCloudflareProvider({
    token: TOKEN,
    apiUrl: fake.url,
    propagation: {
      intervalMs: 1,
      resolveServer: (name) => Promise.resolve([name === 'ns1.test' ? '192.0.2.1' : '192.0.2.2']),
      readTxt: (server) => {
        asked.push(server);

        return Promise.resolve(['a', 'b']);
      },
    },
  });

  await provider.waitForTxt('_acme-challenge.imp.example.com', ['a', 'b']);

  expect(asked).toEqual(['192.0.2.1', '192.0.2.2']);
});
