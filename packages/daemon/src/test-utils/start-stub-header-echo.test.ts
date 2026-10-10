import { expect, onTestFinished, test } from 'bun:test';
import { startStubHeaderEcho } from './start-stub-header-echo';

test('it answers a request with the path, Host and forwarding headers it got', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const echo = startStubHeaderEcho(stack);

  const response = await fetch(`http://127.0.0.1:${String(echo.port)}/a/b?c=d`, {
    headers: {
      host: 'web.imp.test',
      cookie: 'a=1',
      authorization: 'Bearer token',
      'x-forwarded-for': '198.51.100.9',
      forwarded: 'for=198.51.100.9',
      'x-real-ip': '198.51.100.9',
      'x-forwarded-host': 'web.imp.test',
      'x-forwarded-proto': 'https',
    },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    path: '/a/b',
    proto: 'https',
    host: 'web.imp.test',
    cookie: 'a=1',
    authorization: 'Bearer token',
    forwardedFor: '198.51.100.9',
    forwarded: 'for=198.51.100.9',
    realIp: '198.51.100.9',
    forwardedHost: 'web.imp.test',
  });
});

test('it answers null for each header a request leaves out', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const echo = startStubHeaderEcho(stack);

  const response = await fetch(`http://127.0.0.1:${String(echo.port)}/`);
  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    path: '/',
    proto: null,
    host: `127.0.0.1:${String(echo.port)}`,
    cookie: null,
    authorization: null,
    forwardedFor: null,
    forwarded: null,
    realIp: null,
    forwardedHost: null,
  });
});

test('it sends a WebSocket message back', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const echo = startStubHeaderEcho(stack);

  const socket = new WebSocket(`ws://127.0.0.1:${String(echo.port)}/`);

  onTestFinished(() => {
    socket.close();
  });

  const reply = new Promise<string>((resolve) => {
    socket.addEventListener('message', (event) => {
      resolve(String(event.data));
    });
  });

  await new Promise((resolve) => {
    socket.addEventListener('open', resolve);
  });

  socket.send('hello');

  const echoed = await reply;

  expect(echoed).toBe('hello');
});

test('it stops answering once its stack is released', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const echo = startStubHeaderEcho(stack);

  await stack.disposeAsync();

  expect(fetch(`http://127.0.0.1:${String(echo.port)}/`)).rejects.toThrow();
});
