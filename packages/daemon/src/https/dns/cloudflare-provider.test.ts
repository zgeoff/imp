import { expect, mock, test } from 'bun:test';
import { server } from '@imp/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { buildStubCloudflareApi } from '../../test-utils/build-stub-cloudflare-api';
import { createCloudflareProvider } from './cloudflare-provider';
import { buildPublicOwner } from './dns-provider';

test('it adds a TXT value to the zone that holds the name, with a short TTL', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  const record = await provider.addTxt('_acme-challenge.imp.example.com', 'value-one');

  expect(api.readRecords()).toStrictEqual([
    {
      id: expect.toBeString(),
      zone_id: 'z1',
      type: 'TXT',
      name: '_acme-challenge.imp.example.com',
      content: 'value-one',
      ttl: 60,
      proxied: false,
      comment: null,
    },
  ]);

  expect(record).toStrictEqual({
    fqdn: '_acme-challenge.imp.example.com',
    value: 'value-one',
    id: `z1/${api.readRecords()[0]?.id ?? ''}`,
  });
});

test('it keeps two TXT values of one name side by side', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  await provider.addTxt('_acme-challenge.imp.example.com', 'value-one');
  await provider.addTxt('_acme-challenge.imp.example.com', 'value-two');

  expect(api.readRecords().map((record) => record.content)).toStrictEqual([
    'value-one',
    'value-two',
  ]);
});

test('it removes only the TXT value it is given', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  const first = await provider.addTxt('_acme-challenge.imp.example.com', 'value-one');

  await provider.addTxt('_acme-challenge.imp.example.com', 'value-two');
  await provider.removeTxt(first);

  expect(api.readRecords().map((record) => record.content)).toStrictEqual(['value-two']);
});

test('it finds the zone by walking up the labels, once per name', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  await provider.addTxt('_acme-challenge.deep.imp.example.com', 'v');
  await provider.addTxt('_acme-challenge.deep.imp.example.com', 'w');

  expect(
    api.requests.filter((request) => request.path.startsWith('/zones?')).map((call) => call.path),
  ).toStrictEqual([
    '/zones?name=_acme-challenge.deep.imp.example.com',
    '/zones?name=deep.imp.example.com',
    '/zones?name=imp.example.com',
    '/zones?name=example.com',
  ]);
});

test('it never asks for a wildcard label as a zone', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  await provider.setA('*.imp.example.com', '100.64.0.7');

  expect(
    api.requests.filter((request) => request.path.startsWith('/zones?')).map((call) => call.path),
  ).toStrictEqual(['/zones?name=imp.example.com', '/zones?name=example.com']);
});

test('it sets an A record DNS only and marked as its own', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  await provider.setA('*.imp.example.com', '100.64.0.7');

  expect(api.readRecords()).toStrictEqual([
    {
      id: expect.toBeString(),
      zone_id: 'z1',
      type: 'A',
      name: '*.imp.example.com',
      content: '100.64.0.7',
      ttl: 300,
      proxied: false,
      comment: 'managed by impd',
    },
  ]);
});

test('it changes its own A record in place, and turns proxying off', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  await api.records.create({
    id: 'r1',
    zone_id: 'z1',
    type: 'A',
    name: '*.imp.example.com',
    content: '100.64.0.7',
    proxied: true,
    comment: 'managed by impd',
  });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  await provider.setA('*.imp.example.com', '100.64.0.8');

  expect(api.readRecords()).toStrictEqual([
    {
      id: 'r1',
      zone_id: 'z1',
      type: 'A',
      name: '*.imp.example.com',
      content: '100.64.0.8',
      ttl: 300,
      proxied: false,
      comment: 'managed by impd',
    },
  ]);
});

test('it leaves its own A record unwritten when it already holds the address', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  await api.records.create({
    zone_id: 'z1',
    type: 'A',
    name: 'imp.example.com',
    content: '100.64.0.7',
    comment: 'managed by impd',
  });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  await provider.setA('imp.example.com', '100.64.0.7');

  expect(api.requests.map((request) => request.method)).toStrictEqual(['GET', 'GET', 'GET']);
});

test('it never replaces an address record it did not make, and names it', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  // the zone apex, with a website on it
  await api.records.create({
    id: 'web',
    zone_id: 'z1',
    type: 'A',
    name: 'example.com',
    content: '203.0.113.5',
  });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });
  const setting = provider.setA('example.com', '100.64.0.7');

  expect(setting).rejects.toThrowWithMessage(
    Error,
    'Cloudflare: example.com already has a record impd did not make (A 203.0.113.5); remove it, or give impd a name of its own in IMP_DOMAIN',
  );

  expect(api.records.findFirst((query) => query.where({ id: 'web' }))?.content).toBe('203.0.113.5');
});

test('it warns when it finds more than one A record of its own', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });
  const log = mock<(message: string) => void>();

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  await api.records.create({
    zone_id: 'z1',
    name: 'two.example.com',
    content: '100.64.0.1',
    comment: 'managed by impd',
  });

  await api.records.create({
    zone_id: 'z1',
    name: 'two.example.com',
    content: '100.64.0.1',
    comment: 'managed by impd',
  });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token'), log });

  await provider.setA('two.example.com', '100.64.0.9');

  expect(log).toHaveBeenCalledExactlyOnceWith(
    'impd: https: warning: two.example.com has 2 A records impd made; it updates only the first',
  );
});

test('it lists only its owner’s A records under the domain, page by page', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'], maxPerPage: 2 });
  const owner = buildPublicOwner('pub.example.com');

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  await api.records.create({
    zone_id: 'z1',
    name: 'web.pub.example.com',
    content: '203.0.113.7',
    comment: owner,
  });

  await api.records.create({
    zone_id: 'z1',
    name: 'api.pub.example.com',
    content: '203.0.113.8',
    comment: owner,
  });

  await api.records.create({
    zone_id: 'z1',
    name: 'db.pub.example.com',
    content: '203.0.113.9',
    comment: owner,
  });

  // someone else's, the bare domain, another domain and another impd's
  await api.records.create({ zone_id: 'z1', name: 'web.pub.example.com', content: '198.51.100.1' });

  await api.records.create({
    zone_id: 'z1',
    name: 'pub.example.com',
    content: '100.64.0.7',
    comment: owner,
  });

  await api.records.create({
    zone_id: 'z1',
    name: 'other.example.com',
    content: '203.0.113.6',
    comment: owner,
  });

  await api.records.create({
    zone_id: 'z1',
    name: 'dev.pub.example.com',
    content: '100.64.0.8',
    comment: 'managed by impd',
  });

  await api.records.create({
    zone_id: 'z1',
    type: 'TXT',
    name: 'txt.pub.example.com',
    content: 'v',
    comment: owner,
  });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  const listed = await provider.listA('pub.example.com', owner);

  expect(listed).toStrictEqual(
    new Map([
      ['web.pub.example.com', '203.0.113.7'],
      ['api.pub.example.com', '203.0.113.8'],
      ['db.pub.example.com', '203.0.113.9'],
    ]),
  );
});

test('it lists every page without result_info until a page is short', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'], hasResultInfo: false });
  const owner = buildPublicOwner('pub.example.com');

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  // one more than the provider's page of 500
  await api.records.createMany(501, (index) => ({
    zone_id: 'z1',
    name: `imp${String(index)}.pub.example.com`,
    content: '203.0.113.7',
    comment: owner,
  }));

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  const listed = await provider.listA('pub.example.com', owner);

  expect(listed.size).toBe(501);

  expect(
    api.requests
      .filter((request) => request.path.includes('/dns_records'))
      .map((call) => call.path),
  ).toStrictEqual([
    '/zones/z1/dns_records?type=A&name.endswith=.pub.example.com&per_page=500&page=1',
    '/zones/z1/dns_records?type=A&name.endswith=.pub.example.com&per_page=500&page=2',
  ]);
});

test('it removes only its owner’s A records of the name', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });
  const owner = buildPublicOwner('pub.example.com');

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  await api.records.create({
    id: 'p1',
    zone_id: 'z1',
    name: 'web.pub.example.com',
    comment: owner,
  });

  await api.records.create({ id: 'p2', zone_id: 'z1', name: 'web.pub.example.com' });

  await api.records.create({
    id: 'p3',
    zone_id: 'z1',
    name: 'api.pub.example.com',
    comment: owner,
  });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  await provider.removeA('web.pub.example.com', owner);

  expect(api.readRecords().map((record) => record.id)).toStrictEqual(['p2', 'p3']);
});

test('it never removes another owner’s A record', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  // the bare domain of an impd on dev.pub.example.com
  await api.records.create({
    id: 'p5',
    zone_id: 'z1',
    name: 'dev.pub.example.com',
    comment: 'managed by impd',
  });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  await provider.removeA('dev.pub.example.com', buildPublicOwner('pub.example.com'));

  expect(api.readRecords().map((record) => record.id)).toStrictEqual(['p5']);
});

test('it fails with Cloudflare’s status and message for a refused token, without the token', () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('wrong-secret') });

  expect(provider.addTxt('_acme-challenge.imp.example.com', 'v')).rejects.toThrowWithMessage(
    Error,
    'Cloudflare GET /zones: 403 Invalid access token',
  );
});

test('it rejects a name that no zone the token sees holds', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  expect(provider.setA('imp.other.org', '100.64.0.7')).rejects.toThrowWithMessage(
    Error,
    'Cloudflare: no zone this token can see holds imp.other.org',
  );
});

test('it fails with no Cloudflare answer when the body is not JSON', () => {
  server.use(
    http.get('https://api.cloudflare.com/client/v4/zones', () =>
      HttpResponse.text('<html>bad gateway</html>', { status: 502 }),
    ),
  );

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  expect(provider.setA('imp.example.com', '100.64.0.7')).rejects.toThrowWithMessage(
    Error,
    'Cloudflare GET /zones: 502 no Cloudflare answer',
  );
});

test('it fails with no Cloudflare answer when the JSON is not an envelope', () => {
  server.use(
    http.get('https://api.cloudflare.com/client/v4/zones', () => HttpResponse.json({ zones: [] })),
  );

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  expect(provider.setA('imp.example.com', '100.64.0.7')).rejects.toThrowWithMessage(
    Error,
    'Cloudflare GET /zones: 200 no Cloudflare answer',
  );
});

test('it fails with Cloudflare’s messages when an answer with a 2xx status is not a success', () => {
  server.use(
    http.get('https://api.cloudflare.com/client/v4/zones', () =>
      HttpResponse.json({
        success: false,
        errors: [{ code: 1000, message: 'first' }, { message: 'second' }],
        messages: [],
        result: null,
      }),
    ),
  );

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve('cf-token') });

  expect(provider.setA('imp.example.com', '100.64.0.7')).rejects.toThrowWithMessage(
    Error,
    'Cloudflare GET /zones: 200 first; second',
  );
});

test('it reads the token at each request, and finds the zone again with a new one', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token', 'cf-rotated'] });
  const current = { token: 'cf-token' };

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve(current.token) });

  await provider.setA('rotate.example.com', '100.64.0.7');

  const before = api.requests.length;

  current.token = 'cf-rotated';

  // the first request with the new token drops the zones found with the
  // old one, so the name asks again, once
  await provider.setA('rotate.example.com', '100.64.0.8');
  await provider.setA('rotate.example.com', '100.64.0.9');

  const after = api.requests.slice(before);

  expect(after.map((request) => request.token)).toSatisfyAll(
    (token: string) => token === 'cf-rotated',
  );

  expect(after.filter((request) => request.path === '/zones?name=example.com')).toHaveLength(1);
  expect(api.readRecords().map((record) => record.content)).toStrictEqual(['100.64.0.9']);
});

test('it fails before any call when the token cannot be read', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  const provider = createCloudflareProvider({
    readToken: () =>
      Promise.reject(new Error('the DNS API token file /run/imp/dns/token is empty')),
  });

  await expect(provider.setA('imp.example.com', '100.64.0.7')).toReject();

  expect(api.requests).toStrictEqual([]);
});

test('it passes on the token file’s own error', () => {
  const provider = createCloudflareProvider({
    readToken: () =>
      Promise.reject(new Error('the DNS API token file /run/imp/dns/token is empty')),
  });

  expect(provider.setA('imp.example.com', '100.64.0.7')).rejects.toThrowWithMessage(
    Error,
    'the DNS API token file /run/imp/dns/token is empty',
  );
});

test('it keeps no zone that the old token found after a new one took over', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token', 'cf-rotated'] });
  const current = { token: 'cf-token' };
  const arrived = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const held = { isDone: false };

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com' });

  // the old token's lookup of example.com waits on the wire, then goes on
  // to the API's own answer
  server.use(
    http.get('https://api.cloudflare.com/client/v4/zones', async (info) => {
      const isOld = info.request.headers.get('authorization') === 'Bearer cf-token';

      const name = new URL(info.request.url).searchParams.get('name');

      if (isOld && name === 'example.com' && !held.isDone) {
        held.isDone = true;

        arrived.resolve(undefined);

        await release.promise;
      }
    }),
  );

  const provider = createCloudflareProvider({ readToken: () => Promise.resolve(current.token) });
  const slow = provider.setA('race.example.com', '100.64.0.7');

  await arrived.promise;

  current.token = 'cf-rotated';

  await provider.setA('other-race.example.com', '100.64.0.8');

  release.resolve(undefined);

  await slow;

  const before = api.requests.length;

  await provider.setA('race.example.com', '100.64.0.9');

  expect(api.requests.slice(before).map((request) => request.path)).toContain(
    '/zones?name=race.example.com',
  );
});

test('it keeps the token out of a fetch error', () => {
  const provider = createCloudflareProvider({
    readToken: () => Promise.resolve('cf-token-secret\u0000'),
  });

  expect(provider.setA('imp.example.com', '100.64.0.7')).rejects.toThrowWithMessage(
    Error,
    /^(?!.*cf-token-secret).*<token>/v,
  );
});

test('it waits for the TXT values on every nameserver of the zone', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });
  const asked: string[] = [];

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'example.com', name_servers: ['ns1.test', 'ns2.test'] });

  const provider = createCloudflareProvider({
    readToken: () => Promise.resolve('cf-token'),
    propagation: {
      resolveServer: (name) => Promise.resolve([name === 'ns1.test' ? '192.0.2.1' : '192.0.2.2']),
      readTxt: (address, fqdn) => {
        asked.push(`${address} ${fqdn}`);

        return Promise.resolve(['a', 'b']);
      },
    },
  });

  await provider.waitForTxt('_acme-challenge.imp.example.com', ['a', 'b']);

  expect(asked).toStrictEqual([
    '192.0.2.1 _acme-challenge.imp.example.com',
    '192.0.2.2 _acme-challenge.imp.example.com',
  ]);
});
