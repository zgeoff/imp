import { expect, test } from 'bun:test';
import { buildStubTailscaleServe } from '../test-utils/build-stub-tailscale-serve';
import { createServiceServe, listServeEntries, parseServedServices } from './service-serve';

test('it reads each served service as its ports and proxy targets', () => {
  const json = JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Services: {
      'svc:box': {
        TCP: { '80': { HTTP: true }, '443': { HTTPS: true } },
        Web: {
          'box.tail1234.ts.net:80': { Handlers: { '/': { Proxy: 'http://127.0.0.1:20000' } } },
          'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:20000' } } },
        },
      },
      'svc:raw': { TCP: { '5432': { TCPForward: '127.0.0.1:5432' } } },
    },
  });

  expect(parseServedServices(json)).toStrictEqual(
    new Map([
      ['svc:box', ['80 http://127.0.0.1:20000', '443 http://127.0.0.1:20000']],
      ['svc:raw', []],
    ]),
  );
});

test.each([
  ['no output', ''],
  ['an empty config', '{}'],
  ['output that is not JSON', 'No serve config'],
  ['JSON of the wrong shape', '{"Services": []}'],
])('it reads %s as nothing served', (_label, output) => {
  expect(parseServedServices(output)).toStrictEqual(new Map());
});

test('it lists HTTPS on 443 and HTTP on 80 as what a service to a target serves', () => {
  expect(listServeEntries('http://127.0.0.1:20000')).toStrictEqual([
    '443 http://127.0.0.1:20000',
    '80 http://127.0.0.1:20000',
  ]);
});

test('it serves a service over HTTP on 80, then HTTPS on 443', async () => {
  const tailscale = buildStubTailscaleServe();
  const serve = createServiceServe(tailscale.runChecked);

  await serve.writeServe('svc:box', 'http://127.0.0.1:20000');

  expect(tailscale.calls).toStrictEqual([
    ['tailscale', 'serve', '--service=svc:box', '--http=80', 'http://127.0.0.1:20000'],
    ['tailscale', 'serve', '--service=svc:box', '--https=443', 'http://127.0.0.1:20000'],
  ]);
});

test('it clears a service’s serve config', async () => {
  const tailscale = buildStubTailscaleServe();
  const serve = createServiceServe(tailscale.runChecked);

  await serve.clearServe('svc:box');

  expect(tailscale.calls).toStrictEqual([['tailscale', 'serve', 'clear', 'svc:box']]);
});

test('it reads back what it served from tailscale serve status', async () => {
  const tailscale = buildStubTailscaleServe();
  const serve = createServiceServe(tailscale.runChecked);

  await serve.writeServe('svc:box', 'http://127.0.0.1:20000');

  const served = await serve.readServed();

  expect(served).toStrictEqual(
    new Map([['svc:box', ['80 http://127.0.0.1:20000', '443 http://127.0.0.1:20000']]]),
  );
});

test('it rejects a read when tailscale serve status fails', () => {
  const tailscale = buildStubTailscaleServe();
  const serve = createServiceServe(tailscale.runChecked);

  tailscale.failNext('tailscaled is not running');

  expect(serve.readServed()).rejects.toThrow('tailscaled is not running');
});
