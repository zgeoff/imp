import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestCertificate } from '../test-certificates';
import { createCertManager } from './cert-manager';
import type { Certificate } from './cert-store';
import { createCertStore } from './cert-store';

const DOMAIN = 'imp.test';
const NAMES = ['imp.test', '*.imp.test'];
const MINUTE = 60_000;

function setup(issue: (domain: string) => Promise<Certificate>) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-certs-'));
  const store = createCertStore(dir);
  const clock = { now: Date.now() };
  const logs: string[] = [];

  const writeLog = (message: string): void => {
    logs.push(message);
  };

  const manager = createCertManager({
    domain: DOMAIN,
    store,
    issue,
    now: () => clock.now,
    log: writeLog,
  });

  return {
    store,
    clock,
    logs,
    writeLog,
    manager,
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('with no certificate it issues one and stores it', async () => {
  const fresh = await createTestCertificate({ names: NAMES });

  using ctx = setup(() => Promise.resolve(fresh));

  expect(ctx.manager.load()).toBeNull();

  const renewed = await ctx.manager.renew();

  expect(renewed).toEqual(fresh);
  expect(ctx.manager.load()?.chainPem).toBe(fresh.chainPem.trimEnd());
  expect(ctx.store.readAttempts().failures).toBe(0);

  // fresh: nothing to do
  const again = await ctx.manager.renew();

  expect(again).toBeNull();
});

test('a failure backs off across restarts', async () => {
  const calls: number[] = [];

  using ctx = setup(() => {
    calls.push(ctx.clock.now);

    return Promise.reject(new Error('Cloudflare POST /zones/z1/dns_records: 403 bad token'));
  });

  const first = await ctx.manager.renew();

  expect(first).toBeNull();
  expect(calls).toHaveLength(1);
  expect(ctx.store.readAttempts()).toMatchObject({ failures: 1 });
  expect(ctx.logs.at(-1)).toContain('403 bad token; the next try is after');

  // a restart reads the backoff from disk
  const restarted = createCertManager({
    domain: DOMAIN,
    store: ctx.store,
    issue: () => {
      calls.push(ctx.clock.now);

      return Promise.reject(new Error('still failing'));
    },
    now: () => ctx.clock.now,
    log: ctx.writeLog,
  });

  ctx.clock.now += 14 * MINUTE;

  const early = await restarted.renew();

  expect(early).toBeNull();
  expect(calls).toHaveLength(1);

  ctx.clock.now += MINUTE;

  await restarted.renew();

  expect(calls).toHaveLength(2);
  expect(ctx.store.readAttempts()).toMatchObject({ failures: 2, lastError: 'still failing' });
});

test('an attempt counts as failed while it runs, so a crash still backs off', async () => {
  const seen: number[] = [];

  const fresh = await createTestCertificate({ names: NAMES });

  using ctx = setup(() => {
    seen.push(ctx.store.readAttempts().failures);

    return Promise.resolve(fresh);
  });

  await ctx.manager.renew();

  expect(seen).toEqual([1]);
});

test('two renewals at once ask the CA once', async () => {
  const fresh = await createTestCertificate({ names: NAMES });

  let calls = 0;

  using ctx = setup(async () => {
    calls += 1;

    await Bun.sleep(10);

    return fresh;
  });

  const [first, second] = await Promise.all([ctx.manager.renew(), ctx.manager.renew()]);

  expect(calls).toBe(1);
  expect(first).toEqual(fresh);
  expect(second).toEqual(fresh);
});

test('an expired certificate on disk still loads, with a warning', async () => {
  const expired = await createTestCertificate({
    names: NAMES,
    notBefore: new Date(Date.now() - 100 * 86_400_000),
    notAfter: new Date(Date.now() - 10 * 86_400_000),
  });

  using ctx = setup(() => Promise.reject(new Error('the CA is down')));

  ctx.store.writeCertificate(expired);

  expect(ctx.manager.load()?.chainPem).toBe(expired.chainPem.trimEnd());
  expect(ctx.logs.at(-1)).toContain('serving it until a renewal succeeds');

  // the renewal fails; the expired certificate stays
  const renewed = await ctx.manager.renew();

  expect(renewed).toBeNull();
  expect(ctx.manager.load()).not.toBeNull();
});

test('a certificate for another domain is replaced', async () => {
  const other = await createTestCertificate({ names: ['other.test', '*.other.test'] });
  const fresh = await createTestCertificate({ names: NAMES });

  using ctx = setup(() => Promise.resolve(fresh));

  ctx.store.writeCertificate(other);

  const renewed = await ctx.manager.renew();

  expect(renewed).toEqual(fresh);
  expect(ctx.logs[0]).toContain('does not cover imp.test, *.imp.test');
});
