import { expect, test } from 'bun:test';
import { parseHostName } from './parse-host-name';

test.each([
  ['dev.imp.localhost:7080', 'dev'],
  ['dev.imp.localhost', 'dev'],
  ['Web-1.example.com.', 'web-1'],
  ['api.imp.tail1234.ts.net:7080', 'api'],
])('it takes the imp name from the first label of %s', (host, expected) => {
  expect(parseHostName(host)).toBe(expected);
});

test.each([
  ['localhost:7080', 'a bare host with a port'],
  ['imp', 'a single label'],
  ['10.66.0.2:8080', 'an IPv4 address'],
  ['[::1]:7080', 'an IPv6 address'],
  ['9lives.example.com', 'a label that is no imp name'],
])('it gives null for %s, %s', (host) => {
  expect(parseHostName(host)).toBeNull();
});

test('it gives null when there is no host', () => {
  expect(parseHostName(null)).toBeNull();
});
