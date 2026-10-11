import { expect, onTestFinished, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import * as z from 'zod';
import { config } from '../lib/config';
import { readInContainer, readWakeMs } from '../lib/container-https';
import { resolveImageName } from '../lib/fixtures';
import { assertState, createInstanceClient, runImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import {
  instance,
  readImpdLogSince,
  readImpdLoggedMs,
  runDevScript,
  runInContainer,
} from '../lib/instance';
import {
  PEBBLE_DOMAIN,
  PUBLIC_HTTPS_PORT,
  buildPebbleEnv,
  isPebbleRunning,
  writePebbleRoot,
} from '../lib/pebble';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// HTTPS through Pebble, which the harness starts only for a run with this
// suite. Each test reboots the instance onto HTTPS, without the certificate
// and account of an earlier start, and back to plain impd at its end.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('https'), stack, client };
}

test.skipIf(!isPebbleRunning())(
  'it gets a wildcard certificate from Pebble, serves and wakes imps at https://<name>.<domain>, and redirects plain http there',
  async () => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}a`;
    const host = `${name}.${PEBBLE_DOMAIN}`;

    // Pebble forgets every account on each start
    await runInContainer([
      'rm',
      '-f',
      '/var/lib/imp/tls/certificate.pem',
      '/var/lib/imp/tls/attempts.json',
      '/var/lib/imp/tls/account.json',
    ]);

    // in-test, not suite settings: impd must start with the files above gone
    await runDevScript('reboot', instance, buildPebbleEnv());

    ctx.stack.defer(() => runDevScript('reboot'));

    await writePebbleRoot();

    // the bare domain is the API
    const health = await waitFor(
      `https://${PEBBLE_DOMAIN}/health`,
      async () => {
        const response = await readInContainer(`https://${PEBBLE_DOMAIN}/health`);

        if (response.status !== 200) {
          throw new Error(`status ${String(response.status)}`);
        }

        return response;
      },
      { timeoutMs: 120_000, intervalMs: 1000 },
    );

    const issueMs = await readImpdLoggedMs(`got a certificate for ${PEBBLE_DOMAIN}`);

    writeMetric('https_issue_ms', issueMs);

    // the key in the same file never leaves this process
    const pem = await runInContainer(['cat', '/var/lib/imp/tls/certificate.pem']);
    const mode = await runInContainer(['stat', '-c', '%a', '/var/lib/imp/tls/certificate.pem']);

    const leafPem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/v.exec(
      pem.stdout,
    );

    const leaf = new X509Certificate(leafPem?.[0] ?? '');

    expect(health.body).toContain('"status":"ok"');
    expect(leaf.subjectAltName).toContain(`DNS:${PEBBLE_DOMAIN}`);
    expect(leaf.subjectAltName).toContain(`DNS:*.${PEBBLE_DOMAIN}`);
    expect(mode.stdout.trim()).toBe('600');

    await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);
    await holdImp(name);

    const urls = await runImp('url', name);

    const served = await waitFor(`https://${host}/`, async () => {
      const response = await readInContainer(`https://${host}/`);

      if (response.status !== 200) {
        throw new Error(`status ${String(response.status)}`);
      }

      return response;
    });

    expect(urls.split('\n')[0]).toBe(`https://${host}`);
    expect(served.body).toBe('e2e-tiny-ok');

    // a request over each scheme wakes the sleeping imp, so the two compare
    await runImp('hold', name, '0');
    await runImp('sleep', name);
    await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'));

    const wokenHttps = await readInContainer(`https://${host}/`);

    const httpsWakeMs = readWakeMs(wokenHttps.headers);

    await runImp('sleep', name);
    await waitFor(`${name} to sleep again`, () => assertState(name, 'sleeping'));

    const wokenHttp = await readInContainer(`http://${name}.imp.localhost:7080/`);

    const httpWakeMs = readWakeMs(wokenHttp.headers);

    writeMetric('https_wake_ms', { impd: httpsWakeMs, client: wokenHttps.totalMs });
    writeMetric('http_wake_ms', { impd: httpWakeMs, client: wokenHttp.totalMs });

    expect(wokenHttps.body).toBe('e2e-tiny-ok');
    expect(httpsWakeMs).toBeGreaterThan(0);
    expect(wokenHttp.body).toBe('e2e-tiny-ok');
    expect(httpWakeMs).toBeGreaterThan(0);

    // only one label names an imp; the certificate does not cover a.<host>
    // either, so the Host header carries it
    const nested = await readInContainer(`https://${host}/`, { host: `a.${host}` });
    const redirect = await readInContainer(`http://${host}/path?q=1`);

    expect(nested.status).toBe(404);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.toLowerCase()).toContain(`location: https://${host}/path?q=1`);
  },
);

test.skipIf(!isPebbleRunning())(
  'it serves a public imp on the public listener behind its token, wakes it only with the token, and no other imp there',
  async () => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}p`;
    const publicUrl = `https://${name}.${PEBBLE_DOMAIN}:${String(PUBLIC_HTTPS_PORT)}/`;

    await runInContainer([
      'rm',
      '-f',
      '/var/lib/imp/tls/certificate.pem',
      '/var/lib/imp/tls/attempts.json',
      '/var/lib/imp/tls/account.json',
    ]);

    // in-test, not suite settings: impd must start with the files above gone
    await runDevScript('reboot', instance, buildPebbleEnv());

    ctx.stack.defer(() => runDevScript('reboot'));

    await writePebbleRoot();

    await waitFor(
      'the certificate',
      async () => {
        const response = await readInContainer(`https://${PEBBLE_DOMAIN}/health`);

        if (response.status !== 200) {
          throw new Error(`status ${String(response.status)}`);
        }
      },
      { timeoutMs: 120_000, intervalMs: 1000 },
    );

    await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);

    // tailnet-only: a 404 on the public listener, with a Host that names it,
    // and the bare domain's API is not there either
    const hidden = await readInContainer(publicUrl);
    const apex = await readInContainer(publicUrl, { host: PEBBLE_DOMAIN });

    expect(hidden.status).toBe(404);
    expect(apex.status).toBe(404);

    const exposeStarted = new Date();

    const exposedJson = await runImp('expose', name, '--auth', 'token', '--json');

    const exposed = z
      .object({ url: z.string(), auth: z.string(), credential: z.string() })
      .parse(JSON.parse(exposedJson));

    expect(exposed).toMatchObject({ url: `https://${name}.${PEBBLE_DOMAIN}`, auth: 'token' });

    // the imp's own record, at the public IP, through challtestsrv
    await waitFor('the public record', async () => {
      const log = await readImpdLogSince(exposeStarted);

      if (!log.includes(`${name}.${PEBBLE_DOMAIN} points at 203.0.113.7 (public)`)) {
        throw new Error('no public record logged yet');
      }
    });

    await runImp('sleep', name);
    await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'));

    // asleep, a request without the token must not wake it
    const refused = await readInContainer(publicUrl);

    expect(refused.status).toBe(401);

    await assertState(name, 'sleeping');

    const served = await readInContainer(publicUrl, {
      authorization: `Bearer ${exposed.credential}`,
    });

    const ls = await runImp('ls');

    expect(served).toMatchObject({ status: 200, body: 'e2e-tiny-ok' });
    expect(ls).toContain('public (token)');

    const unexposeStarted = new Date();

    await runImp('unexpose', name);

    const after = await readInContainer(publicUrl, {
      authorization: `Bearer ${exposed.credential}`,
    });

    expect(after.status).toBe(404);

    await waitFor('the public record to go', async () => {
      const log = await readImpdLogSince(unexposeStarted);

      if (!log.includes(`removed ${name}.${PEBBLE_DOMAIN} (no longer public)`)) {
        throw new Error('no removal logged yet');
      }
    });
  },
);
