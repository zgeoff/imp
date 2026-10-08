import { expect, test } from 'bun:test';
import { buildStubTailscale } from '../test-utils/build-stub-tailscale';
import { createKnownHosts, isAllowedAmbientRequest } from './ambient-request';

test.each([
  ['imp:7070'],
  ['IMP.tail1234.ts.net:7070'],
  ['[::1]:7070'],
  ['[FD7A:115C:A1E0::7]:7070'],
  ['localhost'],
])(
  '#isAllowedAmbientRequest takes the known host %p from a client that is not a browser',
  (host) => {
    const request = new Request(`http://${host}/rpc/system/info`, { headers: { host } });

    expect(
      isAllowedAmbientRequest(
        request,
        new Set(['localhost', '[::1]', '[fd7a:115c:a1e0::7]', 'imp', 'imp.tail1234.ts.net']),
      ),
    ).toBeTrue();
  },
);

test('#isAllowedAmbientRequest refuses a host impd does not know, as after DNS rebinding', () => {
  const request = new Request('http://rebound.example:7070/rpc/system/info', {
    headers: { host: 'rebound.example:7070' },
  });

  expect(isAllowedAmbientRequest(request, new Set(['localhost', 'imp']))).toBeFalse();
});

test('#isAllowedAmbientRequest refuses a request with no host', () => {
  const request = new Request('http://imp:7070/rpc/system/info', { headers: { host: '' } });

  expect(isAllowedAmbientRequest(request, new Set(['imp']))).toBeFalse();
});

test('#isAllowedAmbientRequest refuses a host header that names no host', () => {
  const request = new Request('http://imp:7070/rpc/system/info', {
    headers: { host: 'imp 7070' },
  });

  expect(isAllowedAmbientRequest(request, new Set(['imp']))).toBeFalse();
});

test('#isAllowedAmbientRequest takes a browser on impd’s own origin', () => {
  const request = new Request('http://imp:7070/rpc/system/info', {
    headers: { host: 'imp:7070', origin: 'http://imp:7070', 'sec-fetch-site': 'same-origin' },
  });

  expect(isAllowedAmbientRequest(request, new Set(['imp']))).toBeTrue();
});

test('#isAllowedAmbientRequest takes a navigation the user typed', () => {
  const request = new Request('http://imp:7070/', {
    headers: { host: 'imp:7070', 'sec-fetch-site': 'none' },
  });

  expect(isAllowedAmbientRequest(request, new Set(['imp']))).toBeTrue();
});

test.each([
  [
    { origin: 'http://imp:20000', 'sec-fetch-site': 'same-site' },
    'an imp’s page with fetch metadata',
  ],
  [{ origin: 'http://imp:20000' }, 'an imp’s page without fetch metadata'],
  [{ origin: 'null' }, 'an opaque origin'],
  [{ 'sec-fetch-site': 'cross-site' }, 'a page on another site'],
  [{ origin: 'http://[imp' }, 'an origin that is no URL'],
])('#isAllowedAmbientRequest refuses %p, from %s', (headers) => {
  const request = new Request('http://imp:7070/rpc/system/info', {
    headers: { host: 'imp:7070', ...headers },
  });

  expect(isAllowedAmbientRequest(request, new Set(['imp']))).toBeFalse();
});

test('#createKnownHosts knows loopback, the node’s names and addresses, and the domain', async () => {
  const tailscale = buildStubTailscale({
    status: {
      hostname: 'imp-1',
      dnsName: 'imp-1.tail1234.ts.net',
      ip: '100.64.0.7',
      ips: ['100.64.0.7', 'fd7a:115c:a1e0:0::7'],
    },
  });

  const hosts = createKnownHosts({
    readTailscale: tailscale.readTailscale,
    domain: 'imp.example.com',
  });

  const known = await hosts.read();

  expect([...known]).toIncludeSameMembers([
    '127.0.0.1',
    '100.64.0.7',
    '[fd7a:115c:a1e0::7]',
    '[::1]',
    'imp-1',
    'imp-1.tail1234.ts.net',
    'imp.example.com',
    'localhost',
  ]);
});

test('#createKnownHosts knows loopback alone with no node and no domain', async () => {
  const tailscale = buildStubTailscale({
    status: { state: null, hostname: null, dnsName: null, ip: null, ips: [] },
  });

  const hosts = createKnownHosts({ readTailscale: tailscale.readTailscale, domain: null });

  const known = await hosts.read();

  expect([...known]).toIncludeSameMembers(['127.0.0.1', '[::1]', 'localhost']);
});
