import { expect, test } from 'bun:test';
import { findHeadEnd, parseConnectHead } from './connect-head';

test('it reads a lowercased host and the port of a CONNECT', () => {
  expect(
    parseConnectHead('CONNECT GitHub.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n'),
  ).toStrictEqual({ kind: 'connect', host: 'github.com', port: 443 });
});

test('it reads a bracketed IPv6 host without its brackets', () => {
  expect(parseConnectHead('CONNECT [::1]:22 HTTP/1.1\r\n\r\n')).toStrictEqual({
    kind: 'connect',
    host: '::1',
    port: 22,
  });
});

test('it refuses a method other than CONNECT with a 405', () => {
  expect(parseConnectHead('GET http://github.com/ HTTP/1.1\r\n\r\n')).toStrictEqual({
    kind: 'refused',
    status: 405,
    reason: 'only CONNECT is served',
  });
});

test.each([
  ['a missing port', 'CONNECT github.com HTTP/1.1\r\n\r\n'],
  ['port 0', 'CONNECT github.com:0 HTTP/1.1\r\n\r\n'],
  ['a port past 65535', 'CONNECT github.com:70000 HTTP/1.1\r\n\r\n'],
  ['user info', 'CONNECT user@github.com:443 HTTP/1.1\r\n\r\n'],
])('it refuses a target with %s as not host:port', (_what, head) => {
  expect(parseConnectHead(head)).toStrictEqual({
    kind: 'refused',
    status: 400,
    reason: 'the target is not host:port',
  });
});

test.each([
  ['a space in the target', 'CONNECT git hub.com:443 HTTP/1.1\r\n\r\n'],
  ['another protocol', 'CONNECT github.com:443 SSH/2\r\n\r\n'],
])('it refuses a request line with %s as not HTTP/1', (_what, head) => {
  expect(parseConnectHead(head)).toStrictEqual({
    kind: 'refused',
    status: 400,
    reason: 'not an HTTP/1 request',
  });
});

test('it finds the offset just past the head', () => {
  const buffered = Buffer.from('CONNECT a.b:443 HTTP/1.1\r\n\r\nhello');

  expect(findHeadEnd(buffered)).toBe(buffered.length - 'hello'.length);
});

test('it finds no end in a head still coming', () => {
  expect(findHeadEnd(Buffer.from('CONNECT a.b:443 HTTP/1.1\r\n'))).toBeNull();
});
