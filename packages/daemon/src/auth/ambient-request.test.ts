import { expect, test } from 'bun:test';
import { createKnownHosts, isAllowedAmbientRequest } from './ambient-request';

const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'imp', 'imp.tail1234.ts.net']);

function buildRequest(host: string, headers: Readonly<Record<string, string>> = {}): Request {
  return new Request(`http://${host}/rpc/system/info`, { headers: { host, ...headers } });
}

test('it takes a known host from a client that is not a browser', () => {
  expect(isAllowedAmbientRequest(buildRequest('imp:7070'), HOSTS)).toBeTrue();
  expect(isAllowedAmbientRequest(buildRequest('IMP.tail1234.ts.net:7070'), HOSTS)).toBeTrue();
  expect(isAllowedAmbientRequest(buildRequest('[::1]:7070'), HOSTS)).toBeTrue();
  expect(isAllowedAmbientRequest(buildRequest('rebound.example:7070'), HOSTS)).toBeFalse();
});

test('a browser must be on impd’s own origin', () => {
  const same = { origin: 'http://imp:7070', 'sec-fetch-site': 'same-origin' };
  const impPort = { origin: 'http://imp:20000', 'sec-fetch-site': 'same-site' };

  expect(isAllowedAmbientRequest(buildRequest('imp:7070', same), HOSTS)).toBeTrue();
  expect(isAllowedAmbientRequest(buildRequest('imp:7070', impPort), HOSTS)).toBeFalse();
  expect(isAllowedAmbientRequest(buildRequest('imp:7070', { origin: 'null' }), HOSTS)).toBeFalse();

  expect(
    isAllowedAmbientRequest(buildRequest('imp:7070', { origin: 'http://imp:20000' }), HOSTS),
  ).toBeFalse();
});

test('the known hosts are loopback, the node’s names and addresses, and the domain', async () => {
  const hosts = createKnownHosts({
    readTailscale: () =>
      Promise.resolve({
        state: 'Running',
        hostname: 'imp-1',
        dnsName: 'imp-1.tail1234.ts.net',
        ip: '100.64.0.7',
        ips: ['100.64.0.7', 'fd7a:115c:a1e0:0::7'],
      }),
    domain: 'imp.example.com',
  });

  const known = await hosts.read();

  expect(isAllowedAmbientRequest(buildRequest('[FD7A:115C:A1E0::7]:7070'), known)).toBeTrue();

  expect([...known].toSorted()).toEqual(
    [
      '127.0.0.1',
      '100.64.0.7',
      '[fd7a:115c:a1e0::7]',
      '[::1]',
      'imp-1',
      'imp-1.tail1234.ts.net',
      'imp.example.com',
      'localhost',
    ].toSorted(),
  );
});
