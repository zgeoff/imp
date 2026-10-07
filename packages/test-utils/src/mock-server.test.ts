import { expect, test } from 'bun:test';
import { HttpResponse, http } from 'msw';
import { server } from './mock-server';

test('it answers a request with a handler the test adds', async () => {
  server.use(http.get('https://registry.example.test/v2/', () => HttpResponse.json({ ok: true })));

  const response = await fetch('https://registry.example.test/v2/');
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ ok: true });
});

test('it rejects a request to a remote host that no handler matches', () => {
  const request = fetch('https://unhandled.example.test/v1/info');

  expect(request).rejects.toThrow(/Cannot bypass a request when using the "error" strategy/u);
});
