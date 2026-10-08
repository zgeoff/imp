import { expect, test } from 'bun:test';
import { buildWebSocketUrl } from './build-websocket-url';

test.each([
  ['http://127.0.0.1:7070', 'ws://127.0.0.1:7070/tunnel'],
  ['https://imp.example.com', 'wss://imp.example.com/tunnel'],
  ['https://imp.example.com/base', 'wss://imp.example.com/base/tunnel'],
  ['https://imp.example.com/base//', 'wss://imp.example.com/base/tunnel'],
])('it joins %s and the endpoint as %s', (base, expected) => {
  expect(buildWebSocketUrl(base, '/tunnel')).toBe(expected);
});
