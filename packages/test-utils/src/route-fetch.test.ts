import { expect, mock, test } from 'bun:test';
import { buildRoutedFetch } from './route-fetch';

function setupTest() {
  const nativeFetch = mock(() => Promise.resolve(new Response('native')));
  const mockedFetch = mock(() => Promise.resolve(new Response('mocked')));

  return {
    nativeFetch,
    mockedFetch,
    routed: buildRoutedFetch(
      Object.assign(nativeFetch, { preconnect: fetch.preconnect }),
      Object.assign(mockedFetch, { preconnect: fetch.preconnect }),
    ),
  };
}

test.each([['http://127.0.0.1:4000/v1/info'], ['http://localhost:9000/'], ['http://[::1]:8080/']])(
  'it sends a request to %s to the native fetch with its options',
  async (url) => {
    const ctx = setupTest();
    const init = { tls: { rejectUnauthorized: false } };

    await ctx.routed(url, init);

    expect(ctx.nativeFetch).toHaveBeenCalledExactlyOnceWith(url, init);
  },
);

test('it sends a request over a unix socket to the native fetch with its options', async () => {
  const ctx = setupTest();
  const init = { unix: '/run/docker.sock' };

  await ctx.routed('http://docker/version', init);

  expect(ctx.nativeFetch).toHaveBeenCalledExactlyOnceWith('http://docker/version', init);
});

test('it sends a request to a remote host to the mocked fetch with its options', async () => {
  const ctx = setupTest();
  const init = { method: 'POST', body: 'x' };

  await ctx.routed('https://api.tailscale.com/api/v2/tailnet/-/keys', init);

  expect(ctx.mockedFetch).toHaveBeenCalledExactlyOnceWith(
    'https://api.tailscale.com/api/v2/tailnet/-/keys',
    init,
  );
});

test('it sends a request to a remote host with its own TLS options to the mocked fetch', async () => {
  const ctx = setupTest();

  const response = await ctx.routed('https://upstream.example.test/', {
    tls: { rejectUnauthorized: false },
  });

  const body = await response.text();

  expect(body).toBe('mocked');
});

test('it sends a Request object to a remote host to the mocked fetch', async () => {
  const ctx = setupTest();

  const response = await ctx.routed(new Request('https://api.cloudflare.com/client/v4/zones'));
  const body = await response.text();

  expect(body).toBe('mocked');
});

test('it sends a URL it cannot parse to the mocked fetch', async () => {
  const ctx = setupTest();

  await ctx.routed('/relative/path');

  expect(ctx.mockedFetch).toHaveBeenCalledExactlyOnceWith('/relative/path', undefined);
});
