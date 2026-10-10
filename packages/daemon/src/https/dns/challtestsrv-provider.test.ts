import { expect, mock, test } from 'bun:test';
import { server } from '@imp/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { createChalltestsrvProvider } from './challtestsrv-provider';

test('it sets a TXT value through the management API, with the name fully qualified', async () => {
  const received = mock<(path: string, body: unknown) => void>();

  server.use(
    http.post('http://challtestsrv.test:8055/:command', async (info) => {
      const body: unknown = await info.request.json();

      received(new URL(info.request.url).pathname, body);

      return new HttpResponse(null, { status: 200 });
    }),
  );

  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  const record = await provider.addTxt('_acme-challenge.imp.test', 'value-one');

  expect(received).toHaveBeenCalledExactlyOnceWith('/set-txt', {
    host: '_acme-challenge.imp.test.',
    value: 'value-one',
  });

  expect(record).toStrictEqual({
    fqdn: '_acme-challenge.imp.test',
    value: 'value-one',
    id: 'value-one',
  });
});

test('it clears every TXT value of the name to remove one', async () => {
  const received = mock<(path: string, body: unknown) => void>();

  server.use(
    http.post('http://challtestsrv.test:8055/:command', async (info) => {
      const body: unknown = await info.request.json();

      received(new URL(info.request.url).pathname, body);

      return new HttpResponse(null, { status: 200 });
    }),
  );

  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  await provider.removeTxt({ fqdn: '_acme-challenge.imp.test', value: 'v', id: 'v' });

  expect(received).toHaveBeenCalledExactlyOnceWith('/clear-txt', {
    host: '_acme-challenge.imp.test.',
  });
});

test('it rejects a command the management API refuses, naming the command and status', () => {
  server.use(
    http.post(
      'http://challtestsrv.test:8055/set-txt',
      () => new HttpResponse(null, { status: 400 }),
    ),
  );

  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  expect(provider.addTxt('_acme-challenge.imp.test', 'v')).rejects.toThrowWithMessage(
    Error,
    'challtestsrv /set-txt: 400',
  );
});

test('it waits for nothing before a TXT value counts as set', async () => {
  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  await expect(provider.waitForTxt('_acme-challenge.imp.test', ['v'])).toResolve();
});

test('it adds an A record through the management API, with the name fully qualified', async () => {
  const received = mock<(path: string, body: unknown) => void>();

  server.use(
    http.post('http://challtestsrv.test:8055/:command', async (info) => {
      const body: unknown = await info.request.json();

      received(new URL(info.request.url).pathname, body);

      return new HttpResponse(null, { status: 200 });
    }),
  );

  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  await provider.setA('web.pub.imp.test', '203.0.113.7');

  expect(received).toHaveBeenCalledExactlyOnceWith('/add-a', {
    host: 'web.pub.imp.test.',
    addresses: ['203.0.113.7'],
  });
});

test('it rejects an A record the management API refuses, and lists no record for it', async () => {
  server.use(
    http.post('http://challtestsrv.test:8055/add-a', () => new HttpResponse(null, { status: 500 })),
  );

  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  const [refused] = await Promise.allSettled([
    provider.setA('web.pub.imp.test', '203.0.113.7', 'owner-a'),
  ]);

  const listed = await provider.listA('pub.imp.test', 'owner-a');

  expect(refused).toStrictEqual({
    status: 'rejected',
    reason: new Error('challtestsrv /add-a: 500'),
  });

  expect(listed).toStrictEqual(new Map());
});

test('it keeps listing an A record whose clear the management API refuses', async () => {
  server.use(
    http.post('http://challtestsrv.test:8055/add-a', () => new HttpResponse(null, { status: 200 })),
    http.post(
      'http://challtestsrv.test:8055/clear-a',
      () => new HttpResponse(null, { status: 500 }),
    ),
  );

  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  await provider.setA('web.pub.imp.test', '203.0.113.7', 'owner-a');

  const [refused] = await Promise.allSettled([provider.removeA('web.pub.imp.test', 'owner-a')]);
  const listed = await provider.listA('pub.imp.test', 'owner-a');

  expect(refused).toStrictEqual({
    status: 'rejected',
    reason: new Error('challtestsrv /clear-a: 500'),
  });

  expect(listed).toStrictEqual(new Map([['web.pub.imp.test', '203.0.113.7']]));
});

test('it lists the A records it wrote with this owner under the domain', async () => {
  server.use(
    http.post('http://challtestsrv.test:8055/add-a', () => new HttpResponse(null, { status: 200 })),
  );

  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  await provider.setA('web.pub.imp.test', '203.0.113.7', 'impd public imps of pub.imp.test');
  await provider.setA('api.pub.imp.test', '203.0.113.8');
  await provider.setA('pub.imp.test', '203.0.113.9', 'impd public imps of pub.imp.test');

  const listed = await provider.listA('pub.imp.test', 'impd public imps of pub.imp.test');

  expect(listed).toStrictEqual(new Map([['web.pub.imp.test', '203.0.113.7']]));
});

test('it removes an A record it wrote with this owner', async () => {
  const received = mock<(path: string, body: unknown) => void>();

  server.use(
    http.post('http://challtestsrv.test:8055/:command', async (info) => {
      const body: unknown = await info.request.json();

      received(new URL(info.request.url).pathname, body);

      return new HttpResponse(null, { status: 200 });
    }),
  );

  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  await provider.setA('web.pub.imp.test', '203.0.113.7', 'owner-a');
  await provider.removeA('web.pub.imp.test', 'owner-a');

  expect(received.mock.calls).toStrictEqual([
    ['/add-a', { host: 'web.pub.imp.test.', addresses: ['203.0.113.7'] }],
    ['/clear-a', { host: 'web.pub.imp.test.' }],
  ]);
});

test('it never removes an A record of another owner', async () => {
  const received = mock<(path: string) => void>();

  server.use(
    http.post('http://challtestsrv.test:8055/:command', (info) => {
      received(new URL(info.request.url).pathname);

      return new HttpResponse(null, { status: 200 });
    }),
  );

  const provider = createChalltestsrvProvider('http://challtestsrv.test:8055');

  await provider.setA('web.pub.imp.test', '203.0.113.7', 'owner-a');
  await provider.removeA('web.pub.imp.test', 'owner-b');

  expect(received.mock.calls).toStrictEqual([['/add-a']]);
});
