import { expect, mock, test } from 'bun:test';
import { handleUnhandledRequest } from './handle-unhandled-request';

test('it lets a request to a loopback host through', () => {
  const print = { warning: mock(), error: mock() };

  handleUnhandledRequest(new Request('http://127.0.0.1:4000/v1/info'), print);

  expect(print.error).not.toHaveBeenCalled();
});

test('it fails a request to any other host', () => {
  const print = { warning: mock(), error: mock() };

  handleUnhandledRequest(new Request('https://api.cloudflare.com/client/v4/zones'), print);

  expect(print.error).toHaveBeenCalledOnce();
});
