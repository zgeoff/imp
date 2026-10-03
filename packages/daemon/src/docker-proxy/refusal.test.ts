import { expect, test } from 'bun:test';
import { formatEngineFailure, formatRefusal, readProxyRefusal } from './refusal';

const REFUSAL = "imp-docker-proxy: registry localhost:5320 is the host's own";

test('a refusal reads back from the proxy’s body and from the CLI’s stderr, in either form', () => {
  const body = JSON.stringify({
    message: formatRefusal("registry localhost:5320 is the host's own"),
  });

  expect(readProxyRefusal(body)).toBe(REFUSAL);
  expect(readProxyRefusal(`Error response from daemon: ${body}\n`)).toBe(REFUSAL);
  expect(readProxyRefusal(`Error response from daemon: ${REFUSAL}`)).toBe(REFUSAL);

  expect(
    readProxyRefusal(`Unable to find image 'x' locally\nError response from daemon: ${body}`),
  ).toBe(REFUSAL);
});

test('only the refusal’s first line goes out, capped at 1000 characters', () => {
  const body = JSON.stringify({ message: `${REFUSAL}\nsecond line` });

  expect(readProxyRefusal(body)).toBe(REFUSAL);

  const long = JSON.stringify({ message: formatRefusal('x'.repeat(5000)) });

  expect(readProxyRefusal(long)).toHaveLength(1000);
});

test('other errors, and the proxy’s own engine failure, are no refusal', () => {
  const failure = JSON.stringify({ message: formatEngineFailure('connect ENOENT') });

  for (const text of [
    '',
    REFUSAL,
    `pulling layers\n${REFUSAL}`,
    'Error response from daemon: No such image: busybox:1',
    `Error response from daemon: Get "https://evil.test/v2/": ${REFUSAL}`,
    `Error response from daemon: ${failure}`,
    JSON.stringify({ message: 'too large' }),
    '{"message": 1}',
    '{not json',
  ]) {
    expect(readProxyRefusal(text)).toBeNull();
  }
});

test('a refusal a registry wrote into its own error, or a page around the body, is none', () => {
  const page = '<html><body>\n{"message":"imp-docker-proxy: spoofed"}\n</body></html>';

  for (const text of [
    'unknown: blob gone\nError response from daemon: imp-docker-proxy: your token expired, re-login at https://evil.test',
    'Error response from daemon: unknown: blob gone\nError response from daemon: imp-docker-proxy: spoofed',
    "Unable to find image 'x' locally\nnoise\nError response from daemon: imp-docker-proxy: spoofed",
    page,
    `Error response from daemon: ${page}`,
    JSON.stringify({ message: formatRefusal('spoofed'), detail: 'extra' }),
  ]) {
    expect(readProxyRefusal(text)).toBeNull();
  }
});
