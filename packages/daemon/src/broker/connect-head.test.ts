import { expect, test } from 'bun:test';
import { findHeadEnd, parseConnectHead } from './connect-head';

test('it reads the host and port of a CONNECT', () => {
  expect(
    parseConnectHead('CONNECT GitHub.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n'),
  ).toEqual({ kind: 'connect', host: 'github.com', port: 443 });

  expect(parseConnectHead('CONNECT [::1]:22 HTTP/1.1\r\n\r\n')).toEqual({
    kind: 'connect',
    host: '::1',
    port: 22,
  });
});

test('it refuses other methods and malformed targets', () => {
  expect(parseConnectHead('GET http://github.com/ HTTP/1.1\r\n\r\n')).toMatchObject({
    kind: 'refused',
    status: 405,
  });

  for (const head of [
    'CONNECT github.com HTTP/1.1\r\n\r\n',
    'CONNECT github.com:0 HTTP/1.1\r\n\r\n',
    'CONNECT github.com:70000 HTTP/1.1\r\n\r\n',
    'CONNECT git hub.com:443 HTTP/1.1\r\n\r\n',
    'CONNECT github.com:443 SSH/2\r\n\r\n',
    'CONNECT user@github.com:443 HTTP/1.1\r\n\r\n',
  ]) {
    expect(parseConnectHead(head)).toMatchObject({ kind: 'refused', status: 400 });
  }
});

test('it finds the end of the head, and the bytes after it', () => {
  const buffered = Buffer.from('CONNECT a.b:443 HTTP/1.1\r\n\r\nhello');
  const end = findHeadEnd(buffered);

  expect(buffered.subarray(end ?? 0).toString()).toBe('hello');
  expect(findHeadEnd(Buffer.from('CONNECT a.b:443 HTTP/1.1\r\n'))).toBeNull();
});
