import { expect, test } from 'bun:test';
import { readOkBody } from './http';

test('#readOkBody resolves with the trimmed body of a 2xx', () => {
  const response = Promise.resolve(new Response('  e2e-tiny-ok\n'));

  expect(readOkBody(response)).resolves.toBe('e2e-tiny-ok');
});

test('#readOkBody rejects any other status with the status and the start of the body', () => {
  const response = Promise.resolve(new Response('no imp named e2e-x\n', { status: 404 }));

  expect(readOkBody(response)).rejects.toThrowWithMessage(Error, 'HTTP 404: no imp named e2e-x');
});
