import { afterAll, beforeAll, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { resolveImageName } from '../lib/fixtures';
import { assertState, runImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { readImpdLoggedMs, runDevScript, runInContainer } from '../lib/instance';
import { PEBBLE_DOMAIN, buildPebbleEnv, isPebbleRunning, writePebbleRoot } from '../lib/pebble';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('https');
const TINY = resolveImageName('e2e-tiny');
const name = `${prefix}a`;
const host = `${name}.${PEBBLE_DOMAIN}`;

// the root as the dev container sees it: the repo is mounted at /src
const ROOT_IN_CONTAINER = '/src/.cache/e2e/pebble-root.pem';

interface ContainerResponse {
  readonly status: number;
  readonly headers: string;
  readonly body: string;

  // curl's time_total: connect, TLS, the wake, and the response
  readonly totalMs: number;
}

const TIME_MARK = 'imp-e2e-time-total:';

// the harness starts Pebble only for a run that includes this suite
const pebbleUp = isPebbleRunning();
const pebbleEnv = buildPebbleEnv();

// The instance runs with HTTPS on only for this suite, so the suites after it
// get a plain impd. Pebble makes a new root and forgets every account on each
// start, so impd starts without the certificate and account of an earlier run.
beforeAll(async () => {
  if (!pebbleUp) {
    return;
  }

  Object.assign(process.env, pebbleEnv);

  await runInContainer(['rm', '-f', '/var/lib/imp/tls/certificate.pem']);
  await runInContainer(['rm', '-f', '/var/lib/imp/tls/attempts.json']);
  await runInContainer(['rm', '-f', '/var/lib/imp/tls/account.json']);
  await runDevScript('reboot');
}, 600_000);

afterAll(async () => {
  if (!pebbleUp) {
    return;
  }

  for (const key of Object.keys(pebbleEnv)) {
    delete process.env[key];
  }

  // the instance goes back to HTTPS off
  await runDevScript('reboot');
}, 600_000);

// A request from inside the host container, where the listeners answer on
// loopback. The certificate must chain to Pebble's root and cover the URL's
// name; `hostHeader` can send another Host on that connection.
async function readInContainer(url: string, hostHeader?: string): Promise<ContainerResponse> {
  const target = new URL(url);

  const defaultPort = target.protocol === 'https:' ? '443' : '80';
  const port = target.port === '' ? defaultPort : target.port;

  const result = await runInContainer([
    'curl',
    '-sS',
    '--max-time',
    '30',
    '--cacert',
    ROOT_IN_CONTAINER,
    '--resolve',
    `${target.hostname}:${port}:127.0.0.1`,
    '-D',
    '/dev/stderr',
    '-o',
    '/dev/stdout',
    '-w',
    `\n${TIME_MARK}%{time_total}`,
    ...(hostHeader === undefined ? [] : ['-H', `Host: ${hostHeader}`]),
    url,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`curl ${url} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  const status = /^HTTP\/[\d.]+ (?<status>\d{3})/m.exec(result.stderr)?.groups?.['status'];
  const [body = '', seconds = '0'] = result.stdout.split(`\n${TIME_MARK}`);

  return {
    status: Number(status ?? 0),
    headers: result.stderr,
    body: body.trim(),
    totalMs: Math.round(Number(seconds) * 1000),
  };
}

test.skipIf(!pebbleUp)(
  'impd gets a wildcard certificate from Pebble and serves imps at https://<name>.<domain>',
  async () => {
    await writePebbleRoot();

    // the bare domain is the API
    const health = await waitFor(
      `https://${PEBBLE_DOMAIN}/health`,
      async () => {
        const response = await readInContainer(`https://${PEBBLE_DOMAIN}/health`);

        expect(response.status).toBe(200);

        return response;
      },
      { timeoutMs: 120_000, intervalMs: 1000 },
    );

    expect(health.body).toContain('"status":"ok"');

    const issueMs = await readImpdLoggedMs(`got a certificate for ${PEBBLE_DOMAIN}`);

    writeMetric('https_issue_ms', issueMs);

    // the stored certificate: both names, root-only
    // the key in the same file never leaves this process
    const pem = await runInContainer(['cat', '/var/lib/imp/tls/certificate.pem']);

    const leafPem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem.stdout);

    const leaf = new X509Certificate(leafPem?.[0] ?? '');

    const mode = await runInContainer(['stat', '-c', '%a', '/var/lib/imp/tls/certificate.pem']);

    expect(leaf.subjectAltName).toContain(`DNS:${PEBBLE_DOMAIN}`);
    expect(leaf.subjectAltName).toContain(`DNS:*.${PEBBLE_DOMAIN}`);
    expect(mode.stdout.trim()).toBe('600');

    await createImp(name, '--image', TINY, '--memory', '512');
    await holdImp(name);

    const urls = await runImp('url', name);

    expect(urls.split('\n')[0]).toBe(`https://${host}`);

    const served = await waitFor(`https://${host}/`, async () => {
      const response = await readInContainer(`https://${host}/`);

      expect(response.status).toBe(200);

      return response;
    });

    expect(served.body).toBe('e2e-tiny-ok');

    // A request over https wakes a sleeping imp. Each scheme wakes the same
    // imp twice: at once after the sleep, and after the imp has sat asleep
    // for a while, so the two schemes compare under the same conditions.
    await runImp('hold', name, '0');

    const plainUrl = `http://${name}.imp.localhost:7080/`;

    for (const settleMs of [0, 5000]) {
      for (const [scheme, url] of [
        ['https', `https://${host}/`],
        ['http', plainUrl],
      ] as const) {
        const woken = await wakeBy(url, settleMs);

        const key = `${scheme}_wake${settleMs === 0 ? '' : '_settled'}`;

        writeMetric(`${key}_ms`, woken);
      }
    }

    // only one label names an imp; the certificate does not cover a.<host>
    // either, so the Host header carries it
    const nested = await readInContainer(`https://${host}/`, `a.${host}`);

    expect(nested.status).toBe(404);

    // plain http on the domain goes to https
    const redirect = await readInContainer(`http://${host}/path?q=1`);

    expect(redirect.status).toBe(308);
    expect(redirect.headers.toLowerCase()).toContain(`location: https://${host}/path?q=1`);
  },
);

// Sleeps the imp, waits `settleMs`, then wakes it with a request: impd's own
// wake time (x-imp-wake-ms) and the client's whole request time.
async function wakeBy(url: string, settleMs: number) {
  await runImp('sleep', name);
  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'));

  await Bun.sleep(settleMs);

  const woken = await readInContainer(url);

  const impd = /^x-imp-wake-ms: (?<ms>\d+)/im.exec(woken.headers)?.groups?.['ms'];

  expect(woken.body).toBe('e2e-tiny-ok');
  expect(impd).toBeDefined();

  return { impd: Number(impd), client: woken.totalMs };
}
