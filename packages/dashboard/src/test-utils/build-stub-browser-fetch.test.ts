import { expect, mock, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { buildStubBrowserFetch } from './build-stub-browser-fetch';

test('it marks a request to the page origin as same-origin', async () => {
  const sendRequest = mock<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const innerFetch = Object.assign(sendRequest, { preconnect: fetch.preconnect });
  const browserFetch = buildStubBrowserFetch(innerFetch, 'http://impd.test/ui/');

  await browserFetch('http://impd.test/auth/login', { method: 'POST' });

  const input = sendRequest.mock.calls[0]?.[0];

  invariant(input);

  const request = new Request(input);

  expect(sendRequest).toHaveBeenCalledOnce();
  expect(request.headers.get('sec-fetch-site')).toBe('same-origin');
});

test('it resolves a relative URL against the page', async () => {
  const sendRequest = mock<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const innerFetch = Object.assign(sendRequest, { preconnect: fetch.preconnect });
  const browserFetch = buildStubBrowserFetch(innerFetch, 'http://impd.test/ui/');

  await browserFetch('/auth/logout', { method: 'POST' });

  const input = sendRequest.mock.calls[0]?.[0];

  invariant(input);

  const request = new Request(input);

  expect(sendRequest).toHaveBeenCalledOnce();
  expect(request.url).toBe('http://impd.test/auth/logout');
});

test('it leaves a request to another origin unmarked', async () => {
  const sendRequest = mock<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const innerFetch = Object.assign(sendRequest, { preconnect: fetch.preconnect });
  const browserFetch = buildStubBrowserFetch(innerFetch, 'http://impd.test/ui/');

  await browserFetch('http://other.test/api');

  const input = sendRequest.mock.calls[0]?.[0];

  invariant(input);

  const request = new Request(input);

  expect(sendRequest).toHaveBeenCalledOnce();
  expect(request.headers.get('sec-fetch-site')).toBeNull();
});
