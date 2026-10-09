import { expect, test } from 'bun:test';
import { buildStubTailscaleServe } from '../test-utils/build-stub-tailscale-serve';
import { parseServePorts, readServePorts } from './tailscale-serve';

test('it lists the ports tailscale serve holds', () => {
  const json = JSON.stringify({
    TCP: { '443': { HTTPS: true }, '20000': { HTTPS: true } },
    Web: { 'imp.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:20000' } } } },
  });

  expect(parseServePorts(json)).toStrictEqual([443, 20_000]);
});

test.each([
  ['an empty config', '{}'],
  ['no output', ''],
  ['output that is not JSON', 'No serve config'],
])('it holds no port for %s', (_label, json) => {
  expect(parseServePorts(json)).toStrictEqual([]);
});

test('it skips a TCP key that is not a port', () => {
  const json = JSON.stringify({ TCP: { '443': { HTTPS: true }, web: { HTTPS: true } } });

  expect(parseServePorts(json)).toStrictEqual([443]);
});

test('it reads the held ports from tailscale serve status', async () => {
  const serve = buildStubTailscaleServe();

  serve.holdPort(443);

  const ports = await readServePorts(serve.run);

  expect(ports).toStrictEqual([443]);
});

test('it holds no port when tailscale serve status fails', async () => {
  const serve = buildStubTailscaleServe();

  serve.holdPort(443);
  serve.failNext('tailscaled is not running');

  const ports = await readServePorts(serve.run);

  expect(ports).toStrictEqual([]);
});

test('it holds no port when tailscale cannot run', async () => {
  const ports = await readServePorts(() =>
    Promise.reject(new Error('Executable not found in $PATH: "tailscale"')),
  );

  expect(ports).toStrictEqual([]);
});
