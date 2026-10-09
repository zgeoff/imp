import { expect, onTestFinished, test } from 'bun:test';
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { createUpstreamResolver } from './test-upstreams';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-upstreams-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it sends every host to its real origin without a file', () => {
  const resolve = createUpstreamResolver(null, () => {});

  expect(resolve('api.github.com')).toStrictEqual({ origin: 'https://api.github.com', ca: null });
});

test('it sends every host to its real origin while the file is missing', async () => {
  const ctx = await setupTest();

  const logs: string[] = [];

  const resolve = createUpstreamResolver(join(ctx.dir, 'upstreams.json'), (message) => {
    logs.push(message);
  });

  const upstream = resolve('api.github.com');

  expect(upstream).toStrictEqual({ origin: 'https://api.github.com', ca: null });
  expect(logs).toBeEmpty();
});

test('it sends a listed host to its test origin, trusting the file CA beside the roots', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.dir, 'upstreams.json'),
    JSON.stringify({
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
      upstreams: { 'api.github.com': 'https://172.17.0.1:9443' },
    }),
  );

  const resolve = createUpstreamResolver(join(ctx.dir, 'upstreams.json'), () => {});

  expect(resolve('api.github.com')).toStrictEqual({
    origin: 'https://172.17.0.1:9443',
    ca: [...rootCertificates, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----'],
  });
});

test('it strips a trailing slash from a test origin', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.dir, 'upstreams.json'),
    JSON.stringify({
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
      upstreams: { 'api.github.com': 'https://172.17.0.1:9443/' },
    }),
  );

  const resolve = createUpstreamResolver(join(ctx.dir, 'upstreams.json'), () => {});

  expect(resolve('api.github.com').origin).toBe('https://172.17.0.1:9443');
});

test('it sends a host the file does not list to its real origin', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.dir, 'upstreams.json'),
    JSON.stringify({
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
      upstreams: { 'api.github.com': 'https://172.17.0.1:9443' },
    }),
  );

  const resolve = createUpstreamResolver(join(ctx.dir, 'upstreams.json'), () => {});

  expect(resolve('github.com')).toStrictEqual({ origin: 'https://github.com', ca: null });
});

test('it logs a load once while the file keeps its mtime', async () => {
  const ctx = await setupTest();

  const logs: string[] = [];

  writeFileSync(
    join(ctx.dir, 'upstreams.json'),
    JSON.stringify({
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
      upstreams: {
        'api.github.com': 'https://172.17.0.1:9443',
        'github.com': 'https://172.17.0.1:9444',
      },
    }),
  );

  const resolve = createUpstreamResolver(join(ctx.dir, 'upstreams.json'), (message) => {
    logs.push(message);
  });

  resolve('api.github.com');
  resolve('github.com');

  expect(logs).toStrictEqual([
    `impd: broker: warning: test upstreams from ${join(ctx.dir, 'upstreams.json')} stand in for api.github.com, github.com`,
  ]);
});

test('it reads the file again once its mtime changes', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.dir, 'upstreams.json'),
    JSON.stringify({
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
      upstreams: { 'api.github.com': 'https://172.17.0.1:9443' },
    }),
  );

  utimesSync(join(ctx.dir, 'upstreams.json'), 1000, 1000);

  const resolve = createUpstreamResolver(join(ctx.dir, 'upstreams.json'), () => {});

  resolve('api.github.com');

  writeFileSync(
    join(ctx.dir, 'upstreams.json'),
    JSON.stringify({
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
      upstreams: { 'api.github.com': 'https://172.17.0.1:9555' },
    }),
  );

  utimesSync(join(ctx.dir, 'upstreams.json'), 2000, 2000);

  expect(resolve('api.github.com').origin).toBe('https://172.17.0.1:9555');
});

test('it reads a file again after it was gone, though its mtime is the old one', async () => {
  const ctx = await setupTest();

  const logs: string[] = [];

  const content = JSON.stringify({
    ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
    upstreams: { 'api.github.com': 'https://172.17.0.1:9443' },
  });

  writeFileSync(join(ctx.dir, 'upstreams.json'), content);
  utimesSync(join(ctx.dir, 'upstreams.json'), 1000, 1000);

  const resolve = createUpstreamResolver(join(ctx.dir, 'upstreams.json'), (message) => {
    logs.push(message);
  });

  resolve('api.github.com');
  rmSync(join(ctx.dir, 'upstreams.json'));
  resolve('api.github.com');
  writeFileSync(join(ctx.dir, 'upstreams.json'), content);
  utimesSync(join(ctx.dir, 'upstreams.json'), 1000, 1000);
  resolve('api.github.com');

  expect(logs).toStrictEqual([
    `impd: broker: warning: test upstreams from ${join(ctx.dir, 'upstreams.json')} stand in for api.github.com`,
    `impd: broker: warning: test upstreams from ${join(ctx.dir, 'upstreams.json')} stand in for api.github.com`,
  ]);
});

test('it logs an invalid file and sends every host to its real origin', async () => {
  const ctx = await setupTest();

  const logs: string[] = [];

  // an http upstream: the file allows https only
  writeFileSync(
    join(ctx.dir, 'upstreams.json'),
    JSON.stringify({
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
      upstreams: { 'api.github.com': 'http://172.17.0.1:9443' },
    }),
  );

  const resolve = createUpstreamResolver(join(ctx.dir, 'upstreams.json'), (message) => {
    logs.push(message);
  });

  const upstream = resolve('api.github.com');

  expect(upstream).toStrictEqual({ origin: 'https://api.github.com', ca: null });

  expect(logs).toStrictEqual([
    `impd: broker: ignoring ${join(ctx.dir, 'upstreams.json')}: ${JSON.stringify(
      [
        {
          code: 'invalid_format',
          format: 'url',
          note: 'Invalid protocol',
          pattern: '^https$',
          path: ['upstreams', 'api.github.com'],
          message: 'Invalid URL',
        },
      ],
      null,
      2,
    )}`,
  ]);
});

test('it logs a file that is not JSON and sends every host to its real origin', async () => {
  const ctx = await setupTest();

  const logs: string[] = [];

  writeFileSync(join(ctx.dir, 'upstreams.json'), '{not json');

  const resolve = createUpstreamResolver(join(ctx.dir, 'upstreams.json'), (message) => {
    logs.push(message);
  });

  const upstream = resolve('api.github.com');

  expect(upstream).toStrictEqual({ origin: 'https://api.github.com', ca: null });

  expect(logs).toStrictEqual([
    `impd: broker: ignoring ${join(ctx.dir, 'upstreams.json')}: JSON Parse error: Expected '}'`,
  ]);
});
