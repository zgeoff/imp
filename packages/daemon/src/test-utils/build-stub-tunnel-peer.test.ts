import { expect, test } from 'bun:test';
import { buildStubTunnelPeer } from './build-stub-tunnel-peer';

test('it keeps each text message as the JSON it holds, in order', () => {
  const tunnel = buildStubTunnelPeer();

  tunnel.peer.sendText('{"type":"opened"}');
  tunnel.peer.sendText('{"type":"ack","bytes":5}');

  expect(tunnel.sent).toStrictEqual([{ type: 'opened' }, { type: 'ack', bytes: 5 }]);
});

test('it keeps each binary message as the text it decodes to', () => {
  const tunnel = buildStubTunnelPeer();

  tunnel.peer.sendBinary(new TextEncoder().encode('rows'));

  expect(tunnel.binary).toStrictEqual(['rows']);
});

test('it keeps the code and reason of the close', () => {
  const tunnel = buildStubTunnelPeer();

  tunnel.peer.close(4000, 'past the window');

  expect(tunnel.closed).toStrictEqual({ code: 4000, reason: 'past the window' });
});

test('it shows no close before the session closes the socket', () => {
  const tunnel = buildStubTunnelPeer();

  expect(tunnel.closed).toStrictEqual({ code: null, reason: '' });
});

test('it throws on a text message that is not JSON', () => {
  const tunnel = buildStubTunnelPeer();

  expect(() => {
    tunnel.peer.sendText('opened');
  }).toThrow();
});
