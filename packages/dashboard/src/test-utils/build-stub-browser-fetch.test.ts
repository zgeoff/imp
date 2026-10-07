import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { buildStubBrowserFetch } from './build-stub-browser-fetch';

test('it marks a request to the page origin as same-origin', async () => {
  const sent: Request[] = [];

  // oxlint-disable-next-line prefer-readonly-parameter-types -- fetch's own parameter types
  const sendRequest = (input: RequestInfo | URL): Promise<Response> => {
    sent.push(new Request(input));

    return Promise.resolve(new Response(null, { status: 204 }));
  };

  const innerFetch = Object.assign(sendRequest, { preconnect: fetch.preconnect });
  const browserFetch = buildStubBrowserFetch(innerFetch, 'http://impd.test/ui/');

  await browserFetch('http://impd.test/auth/login', { method: 'POST' });

  const [request] = sent;

  invariant(request);

  expect(request.headers.get('sec-fetch-site')).toBe('same-origin');
});

test('it resolves a relative URL against the page', async () => {
  const sent: Request[] = [];

  // oxlint-disable-next-line prefer-readonly-parameter-types -- fetch's own parameter types
  const sendRequest = (input: RequestInfo | URL): Promise<Response> => {
    sent.push(new Request(input));

    return Promise.resolve(new Response(null, { status: 204 }));
  };

  const innerFetch = Object.assign(sendRequest, { preconnect: fetch.preconnect });
  const browserFetch = buildStubBrowserFetch(innerFetch, 'http://impd.test/ui/');

  await browserFetch('/auth/logout', { method: 'POST' });

  const [request] = sent;

  invariant(request);

  expect(request.url).toBe('http://impd.test/auth/logout');
});

test('it leaves a request to another origin unmarked', async () => {
  const sent: Request[] = [];

  // oxlint-disable-next-line prefer-readonly-parameter-types -- fetch's own parameter types
  const sendRequest = (input: RequestInfo | URL): Promise<Response> => {
    sent.push(new Request(input));

    return Promise.resolve(new Response(null, { status: 204 }));
  };

  const innerFetch = Object.assign(sendRequest, { preconnect: fetch.preconnect });
  const browserFetch = buildStubBrowserFetch(innerFetch, 'http://impd.test/ui/');

  await browserFetch('http://other.test/api');

  const [request] = sent;

  invariant(request);

  expect(request.headers.get('sec-fetch-site')).toBeNull();
});
