import { expect, test } from 'bun:test';
import { parseTunnelServerMessage } from './parse-tunnel-server-message';

test('it reads a control message impd sends', () => {
  expect(parseTunnelServerMessage('{"type":"ack","bytes":4096}')).toStrictEqual({
    type: 'ack',
    bytes: 4096,
  });
});

test('it refuses text that is not JSON as a broken protocol', () => {
  expect(parseTunnelServerMessage('not json')).toBeNull();
});

test('it refuses JSON that is no message of the protocol', () => {
  expect(parseTunnelServerMessage('{"type":"hello"}')).toBeNull();
});
