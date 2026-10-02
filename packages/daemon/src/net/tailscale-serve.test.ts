import { expect, test } from 'bun:test';
import { parseServePorts } from './tailscale-serve';

test('it lists the ports tailscale serve holds', () => {
  const json = JSON.stringify({
    TCP: { '443': { HTTPS: true }, '20000': { HTTPS: true } },
    Web: { 'imp.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:20000' } } } },
  });

  expect(parseServePorts(json)).toEqual([443, 20_000]);
});

test('no serve config, or output it cannot read, holds no port', () => {
  expect(parseServePorts('{}')).toEqual([]);
  expect(parseServePorts('')).toEqual([]);
  expect(parseServePorts('No serve config')).toEqual([]);
});
