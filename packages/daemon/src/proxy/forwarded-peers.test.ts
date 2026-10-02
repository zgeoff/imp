import { expect, test } from 'bun:test';
import { PEER_HEADER, createForwardedPeers, readPeerAddress } from './forwarded-peers';

function buildRequest(handle: string | null): Request {
  return new Request('http://imp.example.com/rpc/system/info', {
    method: 'POST',
    headers: handle === null ? {} : { [PEER_HEADER]: handle },
  });
}

test('a handle the proxy made gives the client’s address once, from loopback only', () => {
  const clock = { at: 0 };
  const peers = createForwardedPeers(() => clock.at);
  const handle = peers.register('100.101.102.103');

  expect(readPeerAddress(buildRequest(handle), '203.0.113.9', peers)).toBe('203.0.113.9');
  expect(readPeerAddress(buildRequest(handle), '127.0.0.1', peers)).toBe('100.101.102.103');
  expect(readPeerAddress(buildRequest(handle), '127.0.0.1', peers)).toBe('127.0.0.1');
});

test('a forged or expired handle gives the socket’s own address', () => {
  const clock = { at: 0 };
  const peers = createForwardedPeers(() => clock.at);
  const handle = peers.register('100.101.102.103');

  expect(readPeerAddress(buildRequest('100.101.102.103'), '::1', peers)).toBe('::1');

  clock.at += 30_000;

  expect(readPeerAddress(buildRequest(handle), '::ffff:127.0.0.1', peers)).toBe('::ffff:127.0.0.1');
  expect(readPeerAddress(buildRequest(null), null, peers)).toBeNull();
});
