import { expect, test } from 'bun:test';
import { PublicMcpEnvSchema, parsePublicMcpConfig } from './public-mcp-config';

test('#PublicMcpEnvSchema accepts an origin and a port, as a number', () => {
  const result = PublicMcpEnvSchema.safeParse({
    IMP_MCP_PUBLIC_URL: 'https://imp.example.com',
    IMP_MCP_PUBLIC_PORT: '7171',
  });

  expect(result.data).toStrictEqual({
    IMP_MCP_PUBLIC_URL: 'https://imp.example.com',
    IMP_MCP_PUBLIC_PORT: 7171,
  });
});

test('#PublicMcpEnvSchema defaults the port to 7071', () => {
  const result = PublicMcpEnvSchema.safeParse({});

  expect(result.data).toStrictEqual({ IMP_MCP_PUBLIC_PORT: 7071 });
});

test.each([
  ['seventy', 'invalid_type'],
  ['0', 'too_small'],
  ['65536', 'too_big'],
  ['71.5', 'invalid_type'],
])('#PublicMcpEnvSchema rejects the port %p as %s', (port, code) => {
  const result = PublicMcpEnvSchema.safeParse({
    IMP_MCP_PUBLIC_URL: 'https://imp.example.com',
    IMP_MCP_PUBLIC_PORT: port,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['IMP_MCP_PUBLIC_PORT'], code });
});

test('#parsePublicMcpConfig turns the route off without IMP_MCP_PUBLIC_URL', () => {
  expect(parsePublicMcpConfig({ IMP_MCP_PUBLIC_PORT: 7999 }, [], [20_000, 20_999])).toBeNull();
});

test('#parsePublicMcpConfig takes a bare https origin', () => {
  expect(
    parsePublicMcpConfig(
      { IMP_MCP_PUBLIC_URL: 'https://imp.example.com', IMP_MCP_PUBLIC_PORT: 7071 },
      [],
      [20_000, 20_999],
    ),
  ).toStrictEqual({ origin: 'https://imp.example.com', host: 'imp.example.com', port: 7071 });
});

test('#parsePublicMcpConfig takes an http origin on a loopback host', () => {
  expect(
    parsePublicMcpConfig(
      { IMP_MCP_PUBLIC_URL: 'http://127.0.0.1:7171', IMP_MCP_PUBLIC_PORT: 7171 },
      [],
      [20_000, 20_999],
    ),
  ).toStrictEqual({ origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 });
});

test('#parsePublicMcpConfig refuses a value that is not a URL', () => {
  expect(() =>
    parsePublicMcpConfig(
      { IMP_MCP_PUBLIC_URL: 'imp.example.com', IMP_MCP_PUBLIC_PORT: 7071 },
      [],
      [20_000, 20_999],
    ),
  ).toThrowWithMessage(Error, 'IMP_MCP_PUBLIC_URL imp.example.com is not a URL');
});

test.each([
  ['https://imp.example.com/'],
  ['https://imp.example.com/mcp'],
  ['https://imp.example.com?a=1'],
  ['https://imp.example.com#top'],
  ['https://user@imp.example.com'],
  ['https://user:pass@imp.example.com'],
])('#parsePublicMcpConfig refuses %p, which is not a bare origin', (url) => {
  expect(() =>
    parsePublicMcpConfig(
      { IMP_MCP_PUBLIC_URL: url, IMP_MCP_PUBLIC_PORT: 7071 },
      [],
      [20_000, 20_999],
    ),
  ).toThrowWithMessage(
    Error,
    `IMP_MCP_PUBLIC_URL ${url} must be a bare origin, such as https://imp.example.com`,
  );
});

test('#parsePublicMcpConfig refuses plain http on a host that is not loopback', () => {
  expect(() =>
    parsePublicMcpConfig(
      { IMP_MCP_PUBLIC_URL: 'http://imp.example.com', IMP_MCP_PUBLIC_PORT: 7071 },
      [],
      [20_000, 20_999],
    ),
  ).toThrowWithMessage(
    Error,
    'IMP_MCP_PUBLIC_URL http://imp.example.com must be https; http is for a loopback host in tests only',
  );
});

test('#parsePublicMcpConfig refuses a port another listener has', () => {
  expect(() =>
    parsePublicMcpConfig(
      { IMP_MCP_PUBLIC_URL: 'https://imp.example.com', IMP_MCP_PUBLIC_PORT: 7071 },
      [['IMP_PORT', 7071]],
      [20_000, 20_999],
    ),
  ).toThrowWithMessage(
    Error,
    'IMP_MCP_PUBLIC_PORT 7071 is also IMP_PORT; give it a port of its own',
  );
});

test('#parsePublicMcpConfig refuses a port among the imps’ ports', () => {
  expect(() =>
    parsePublicMcpConfig(
      { IMP_MCP_PUBLIC_URL: 'https://imp.example.com', IMP_MCP_PUBLIC_PORT: 20_500 },
      [],
      [20_000, 20_999],
    ),
  ).toThrowWithMessage(
    Error,
    "IMP_MCP_PUBLIC_PORT 20500 is one of the imps' ports, 20000 to 20999",
  );
});
