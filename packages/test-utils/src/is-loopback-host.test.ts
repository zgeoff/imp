import { expect, test } from 'bun:test';
import { isLoopbackHost } from './is-loopback-host';

test.each([
  ['http://127.0.0.1:4000/v1/info', true],
  ['https://127.0.0.6/', true],
  ['http://localhost/version', true],
  ['http://[::1]:8080/', true],
  ['https://api.cloudflare.com/client/v4/zones', false],
  ['http://128.0.0.1/', false],
  ['http://localhost.example.test/', false],
  ['http://127.example.test/', false],
  ['http://127.0.0.1.example.test/', false],
])('it reads %s as loopback: %p', (url, expected) => {
  expect(isLoopbackHost(url)).toBe(expected);
});
