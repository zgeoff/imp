import { expect, test } from 'bun:test';
import {
  PEER_HEADER,
  createForwardedPeers,
  isCallerPath,
  readPeerAddress,
} from './forwarded-peers';

test('it gives the client’s address for a handle the proxy made, from loopback', () => {
  const peers = createForwardedPeers(() => 0);
  const handle = peers.register('100.101.102.103');

  const request = new Request('http://imp.example.com/rpc/system/info', {
    headers: { [PEER_HEADER]: handle },
  });

  expect(readPeerAddress(request, '127.0.0.1', peers)).toBe('100.101.102.103');
});

test('it gives the socket’s own address for a handle sent from a remote peer', () => {
  const peers = createForwardedPeers(() => 0);
  const handle = peers.register('100.101.102.103');

  const request = new Request('http://imp.example.com/rpc/system/info', {
    headers: { [PEER_HEADER]: handle },
  });

  expect(readPeerAddress(request, '203.0.113.9', peers)).toBe('203.0.113.9');
});

test('it leaves a handle unused when a remote peer sends it', () => {
  const peers = createForwardedPeers(() => 0);
  const handle = peers.register('100.101.102.103');

  readPeerAddress(
    new Request('http://imp.example.com/rpc/system/info', { headers: { [PEER_HEADER]: handle } }),
    '203.0.113.9',
    peers,
  );

  expect(peers.take(handle)).toBe('100.101.102.103');
});

test('it gives the socket’s own address for a handle used once already', () => {
  const peers = createForwardedPeers(() => 0);
  const handle = peers.register('100.101.102.103');

  peers.take(handle);

  const request = new Request('http://imp.example.com/rpc/system/info', {
    headers: { [PEER_HEADER]: handle },
  });

  expect(readPeerAddress(request, '127.0.0.1', peers)).toBe('127.0.0.1');
});

test('it gives the socket’s own address for a forged handle', () => {
  const peers = createForwardedPeers(() => 0);

  peers.register('100.101.102.103');

  const request = new Request('http://imp.example.com/rpc/system/info', {
    headers: { [PEER_HEADER]: '100.101.102.103' },
  });

  expect(readPeerAddress(request, '::1', peers)).toBe('::1');
});

test('it gives the socket’s own address for a handle 30 seconds old', () => {
  const clock = { at: 0 };
  const peers = createForwardedPeers(() => clock.at);
  const handle = peers.register('100.101.102.103');

  clock.at = 30_000;

  const request = new Request('http://imp.example.com/rpc/system/info', {
    headers: { [PEER_HEADER]: handle },
  });

  expect(readPeerAddress(request, '::ffff:127.0.0.1', peers)).toBe('::ffff:127.0.0.1');
});

test('it redeems a handle just under 30 seconds old', () => {
  const clock = { at: 0 };
  const peers = createForwardedPeers(() => clock.at);
  const handle = peers.register('100.101.102.103');

  clock.at = 29_999;

  expect(peers.take(handle)).toBe('100.101.102.103');
});

test('it gives the socket’s own address for a loopback request with no handle', () => {
  const peers = createForwardedPeers(() => 0);

  const request = new Request('http://imp.example.com/rpc/system/info');

  expect(readPeerAddress(request, '127.0.0.1', peers)).toBe('127.0.0.1');
});

test('it gives null when the socket has no address', () => {
  const peers = createForwardedPeers(() => 0);

  const request = new Request('http://imp.example.com/rpc/system/info');

  expect(readPeerAddress(request, null, peers)).toBeNull();
});

test('it evicts the oldest handle when a handle is made with 1024 held', () => {
  const peers = createForwardedPeers(() => 0);
  const oldest = peers.register('100.64.0.1');

  Array.from({ length: 1024 }, () => peers.register('100.64.1.1'));

  expect(peers.take(oldest)).toBeNull();
});

// the clock steps back after the new handle, so only a handle the store no
// longer holds can read as gone: take alone refuses an expired one
test('it drops an expired handle when it makes a new one', () => {
  const clock = { now: 0 };
  const peers = createForwardedPeers(() => clock.now);
  const expired = peers.register('100.64.0.1');

  clock.now = 30_000;

  peers.register('100.64.1.1');

  clock.now = 0;

  expect(peers.take(expired)).toBeNull();
});

test('it keeps a live handle when it makes a new one', () => {
  const clock = { now: 0 };
  const peers = createForwardedPeers(() => clock.now);
  const live = peers.register('100.64.0.1');

  clock.now = 29_999;

  peers.register('100.64.1.1');

  expect(peers.take(live)).toBe('100.64.0.1');
});

test('it keeps the oldest live handle when a handle is made with 1023 held', () => {
  const peers = createForwardedPeers(() => 0);
  const oldest = peers.register('100.64.0.1');

  Array.from({ length: 1023 }, () => peers.register('100.64.1.1'));

  expect(peers.take(oldest)).toBe('100.64.0.1');
});

test.each([['/rpc/imps/list'], ['/exec'], ['/tunnel'], ['/mcp']])(
  'it resolves a caller on %s',
  (path) => {
    expect(isCallerPath(path)).toBeTrue();
  },
);

test.each([['/ui/'], ['/health'], ['/rpcx'], ['/exec/x'], ['/']])(
  'it resolves no caller on %s',
  (path) => {
    expect(isCallerPath(path)).toBeFalse();
  },
);
