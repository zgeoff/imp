import { expect, mock, test } from 'bun:test';
import { server } from '@imp/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { buildStubCloudflareApi } from '../../test-utils/build-stub-cloudflare-api';
import { createDnsProvider } from './create-dns-provider';

test('it sends a challtestsrv provider’s records to its API', async () => {
  const received = mock<(path: string) => void>();

  server.use(
    http.post('http://challtestsrv.test:8055/:command', (info) => {
      received(new URL(info.request.url).pathname);

      return new HttpResponse(null, { status: 200 });
    }),
  );

  const provider = createDnsProvider(
    { provider: 'challtestsrv', token: null, apiUrl: 'http://challtestsrv.test:8055' },
    null,
    () => {},
  );

  await provider.addTxt('_acme-challenge.imp.test', 'v');

  expect(received).toHaveBeenCalledExactlyOnceWith('/set-txt');
});

test('it sends a Cloudflare provider’s calls to Cloudflare with the token', async () => {
  const api = buildStubCloudflareApi({ tokens: ['cf-token'] });

  server.use(...api.handlers);

  await api.zones.create({ id: 'z1', name: 'imp.test' });

  const provider = createDnsProvider(
    { provider: 'cloudflare', token: { kind: 'value', value: 'cf-token' }, apiUrl: null },
    { read: () => Promise.resolve('cf-token'), check: null },
    () => {},
  );

  await provider.addTxt('_acme-challenge.imp.test', 'v');

  expect(api.readRecords().map((record) => record.content)).toStrictEqual(['v']);
});

test('it sends a Cloudflare provider’s calls to the API the config names', async () => {
  const received = mock<(url: string) => void>();

  server.use(
    http.get('https://cloudflare.proxy.test/client/v4/zones', (info) => {
      received(info.request.url);

      return HttpResponse.json({ success: true, errors: [], messages: [], result: [] });
    }),
  );

  const provider = createDnsProvider(
    {
      provider: 'cloudflare',
      token: { kind: 'value', value: 'cf-token' },
      apiUrl: 'https://cloudflare.proxy.test/client/v4',
    },
    { read: () => Promise.resolve('cf-token'), check: null },
    () => {},
  );

  // no zone answers, so the call fails once it has asked
  await expect(provider.setA('imp.test', '100.64.0.7')).toReject();

  expect(received).toHaveBeenCalledWith(
    'https://cloudflare.proxy.test/client/v4/zones?name=imp.test',
  );
});

test('it rejects a Cloudflare provider with no token', () => {
  expect(() =>
    createDnsProvider({ provider: 'cloudflare', token: null, apiUrl: null }, null, () => {}),
  ).toThrowWithMessage(Error, 'IMP_DNS_PROVIDER=cloudflare needs a token');
});
