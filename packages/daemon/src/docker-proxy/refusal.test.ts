import { expect, test } from 'bun:test';
import { formatEngineFailure, formatRefusal, readProxyRefusal } from './refusal';

test('#formatRefusal prefixes the reason with the proxy name', () => {
  expect(formatRefusal('no')).toBe('imp-docker-proxy: no');
});

test('#formatEngineFailure names the engine call that failed', () => {
  expect(formatEngineFailure('connect ENOENT')).toBe(
    'imp-docker-proxy: the engine call failed: connect ENOENT',
  );
});

test('#readProxyRefusal reads a refusal back from the proxy body', () => {
  const body = JSON.stringify({
    message: "imp-docker-proxy: registry localhost:5320 is the host's own",
  });

  expect(readProxyRefusal(body)).toBe(
    "imp-docker-proxy: registry localhost:5320 is the host's own",
  );
});

test('#readProxyRefusal reads a refusal back from the CLI stderr around the body', () => {
  const body = JSON.stringify({
    message: "imp-docker-proxy: registry localhost:5320 is the host's own",
  });

  expect(readProxyRefusal(`Error response from daemon: ${body}\n`)).toBe(
    "imp-docker-proxy: registry localhost:5320 is the host's own",
  );
});

test('#readProxyRefusal reads a refusal back from the CLI stderr as plain text', () => {
  expect(
    readProxyRefusal(
      "Error response from daemon: imp-docker-proxy: registry localhost:5320 is the host's own",
    ),
  ).toBe("imp-docker-proxy: registry localhost:5320 is the host's own");
});

test('#readProxyRefusal reads a refusal back after the line a create prints first', () => {
  const body = JSON.stringify({
    message: "imp-docker-proxy: registry localhost:5320 is the host's own",
  });

  expect(
    readProxyRefusal(`Unable to find image 'x' locally\nError response from daemon: ${body}`),
  ).toBe("imp-docker-proxy: registry localhost:5320 is the host's own");
});

test('#readProxyRefusal keeps only the first line of a refusal', () => {
  const body = JSON.stringify({ message: 'imp-docker-proxy: refused\nsecond line' });

  expect(readProxyRefusal(body)).toBe('imp-docker-proxy: refused');
});

test('#readProxyRefusal caps a refusal at 1000 characters', () => {
  const body = JSON.stringify({ message: `imp-docker-proxy: ${'x'.repeat(5000)}` });

  expect(readProxyRefusal(body)).toBe(`imp-docker-proxy: ${'x'.repeat(982)}`);
});

// other errors, the proxy's own engine failure, and a refusal a registry
// wrote into its own error or a page around the body
test.each([
  [''],
  ["imp-docker-proxy: registry localhost:5320 is the host's own"],
  ["pulling layers\nimp-docker-proxy: registry localhost:5320 is the host's own"],
  ['Error response from daemon: No such image: busybox:1'],
  ['Error response from daemon: Get "https://evil.test/v2/": imp-docker-proxy: spoofed'],
  ['{"message":"imp-docker-proxy: the engine call failed: connect ENOENT"}'],
  ['Error response from daemon: {"message":"imp-docker-proxy: the engine call failed: x"}'],
  ['{"message":"too large"}'],
  ['{"message": 1}'],
  ['{not json'],
  [
    'unknown: blob gone\nError response from daemon: imp-docker-proxy: your token expired, re-login at https://evil.test',
  ],
  [
    'Error response from daemon: unknown: blob gone\nError response from daemon: imp-docker-proxy: spoofed',
  ],
  [
    "Unable to find image 'x' locally\nnoise\nError response from daemon: imp-docker-proxy: spoofed",
  ],
  ['<html><body>\n{"message":"imp-docker-proxy: spoofed"}\n</body></html>'],
  [
    'Error response from daemon: <html><body>\n{"message":"imp-docker-proxy: spoofed"}\n</body></html>',
  ],
  ['{"message":"imp-docker-proxy: spoofed","detail":"extra"}'],
])('#readProxyRefusal reads no refusal from %p', (text) => {
  expect(readProxyRefusal(text)).toBeNull();
});
