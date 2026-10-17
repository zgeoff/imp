import { expect, mock, test } from 'bun:test';
import { SYSTEM_FEATURES } from '@impz/api';
import { server } from '@impz/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { createRpcClient } from './create-rpc-client';

test('it calls a procedure under the base path with the bearer token', async () => {
  const received = mock<(path: string, authorization: string | null) => void>();

  server.use(
    http.post('http://impd.test/imp/rpc/system/features', (info) => {
      received(new URL(info.request.url).pathname, info.request.headers.get('authorization'));

      return HttpResponse.json({ json: { version: '2.4.1', features: SYSTEM_FEATURES } });
    }),
  );

  const rpc = createRpcClient({ url: 'http://impd.test/imp/', token: 'root-token' });

  await rpc.system.features();

  expect(received).toHaveBeenCalledExactlyOnceWith('/imp/rpc/system/features', 'Bearer root-token');
});

test('it sends no authorization header without a token', async () => {
  const received = mock<(authorization: string | null) => void>();

  server.use(
    http.post('http://impd.test/rpc/system/features', (info) => {
      received(info.request.headers.get('authorization'));

      return HttpResponse.json({ json: { version: '2.4.1', features: SYSTEM_FEATURES } });
    }),
  );

  await createRpcClient({ url: 'http://impd.test', token: null }).system.features();

  expect(received).toHaveBeenCalledExactlyOnceWith(null);
});

test('it rejects a plain-text error answer as an ORPCError with its status', () => {
  // a proxy in front of impd answers while impd is down
  server.use(
    http.post(
      'http://impd.test/rpc/system/features',
      () => new HttpResponse('down', { status: 503 }),
    ),
  );

  const rpc = createRpcClient({ url: 'http://impd.test', token: 'root-token' });

  expect(rpc.system.features()).rejects.toMatchObject({
    code: 'UNEXPECTED_ANSWER',
    status: 503,
    message: 'impd answered with 503',
  });
});

test('it passes impd’s own JSON error through as oRPC reads it', () => {
  server.use(
    http.post('http://impd.test/rpc/system/features', () =>
      HttpResponse.json(
        { json: { defined: false, code: 'UNAUTHORIZED', status: 401, message: 'Unauthorized' } },
        { status: 401 },
      ),
    ),
  );

  const rpc = createRpcClient({ url: 'http://impd.test', token: 'wrong' });

  expect(rpc.system.features()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});

test('it sends the call through a fetch the caller gives', async () => {
  const sent = mock<(path: string) => void>();

  const rpc = createRpcClient({
    url: 'http://in-process.test',
    token: null,
    fetch: (request) => {
      sent(new URL(request.url).pathname);

      return Promise.resolve(
        Response.json({ json: { version: '2.4.1', features: SYSTEM_FEATURES } }),
      );
    },
  });

  await rpc.system.features();

  expect(sent).toHaveBeenCalledExactlyOnceWith('/rpc/system/features');
});
