import { expect, test } from 'bun:test';
import { PublicMcpEnvSchema, parsePublicMcpConfig } from './public-mcp-config';

const SLOTS: readonly [number, number] = [20_000, 20_999];

function parse(
  env: Readonly<Record<string, string>>,
  others: readonly (readonly [string, number])[] = [],
) {
  return parsePublicMcpConfig(PublicMcpEnvSchema.parse(env), others, SLOTS);
}

test('the public route is off until IMP_MCP_PUBLIC_URL is set', () => {
  expect(parse({})).toBeNull();
  expect(parse({ IMP_MCP_PUBLIC_PORT: '7999' })).toBeNull();
});

test('it takes a bare https origin, or http on loopback', () => {
  expect(parse({ IMP_MCP_PUBLIC_URL: 'https://imp.example.com' })).toEqual({
    origin: 'https://imp.example.com',
    host: 'imp.example.com',
    port: 7071,
  });

  expect(
    parse({ IMP_MCP_PUBLIC_URL: 'http://127.0.0.1:7171', IMP_MCP_PUBLIC_PORT: '7171' }),
  ).toEqual({ origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 });
});

test('it refuses anything but a bare origin', () => {
  for (const url of [
    'imp.example.com',
    'https://imp.example.com/',
    'https://imp.example.com/mcp',
    'https://imp.example.com?a=1',
    'https://user@imp.example.com',
    'http://imp.example.com',
  ]) {
    expect(() => parse({ IMP_MCP_PUBLIC_URL: url })).toThrow('IMP_MCP_PUBLIC_URL');
  }
});

test('its port clashes with no other listener and no imp port', () => {
  const env = { IMP_MCP_PUBLIC_URL: 'https://imp.example.com' };

  expect(() => parse(env, [['IMP_PORT', 7071]])).toThrow('is also IMP_PORT');
  expect(() => parse({ ...env, IMP_MCP_PUBLIC_PORT: '20500' })).toThrow("imps' ports");
});
