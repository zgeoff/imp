import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { startFakeUpstream } from '../lib/fake-upstream';
import type { FakeUpstream } from '../lib/fake-upstream';
import { resolveImageName } from '../lib/fixtures';
import { requireImp, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp, holdImp, removeImps } from '../lib/imps';
import { instance, runChecked, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { writeMetric } from '../lib/write-metric';

// The credential broker in a real guest (docs/guides/connectors.md): a fake
// github.com on this machine stands in for the real one, the token is made
// up for the run, and the checks look for it everywhere it must not be.

const prefix = setupSuite('connectors');
const name = `${prefix}a`;

// a neighbour, for its gateway address
const neighbour = `${prefix}b`;
const secret = `${prefix}gh`;
const token = `e2e-${randomUUID()}`;
const upstreamsFile = join(instance.dataDir, 'broker-test-upstreams.json');

const AuditSchema = z.array(
  z.object({
    host: z.string(),
    path: z.string(),
    status: z.number(),
    secret: z.string(),
    requestBytes: z.number(),
  }),
);

let upstream: FakeUpstream;
let repo: string;

// the container's default gateway: this machine, as the broker dials it
async function readContainerGateway(): Promise<string> {
  const route = await runInContainer(['ip', '-4', 'route', 'show', 'default']);

  const gateway = /via (?<ip>[\d.]+)/.exec(route.stdout)?.groups?.['ip'];

  if (gateway === undefined) {
    throw new Error(`no default route in ${instance.container}: ${route.stdout}`);
  }

  return gateway;
}

beforeAll(async () => {
  const gateway = await readContainerGateway();

  upstream = await startFakeUpstream(gateway, token);
  repo = await upstream.createRepo('acme/repo.git');

  writeFileSync(
    upstreamsFile,
    JSON.stringify({
      ca: upstream.caPem,
      upstreams: { 'github.com': upstream.origin, 'api.github.com': upstream.origin },
    }),
  );

  await tryImp(['secret', 'rm', secret]);
  await createImp(name, '--image', resolveImageName('base'), '--memory', '1g');
  await holdImp(name);
}, 300_000);

afterAll(async () => {
  rmSync(upstreamsFile, { force: true });

  await tryImp(['secret', 'rm', secret]);

  await upstream[Symbol.asyncDispose]();
});

test('a secret goes in on stdin and never comes back out of the API', async () => {
  const added = await tryImp(['secret', 'add', secret, '--kind', 'github'], {
    stdin: `${token}\n`,
  });

  expect(added.exitCode).toBe(0);

  await runImp('grant', name, secret);

  const shown = [
    added.stdout,
    await runImp('secret', 'ls', '--json'),
    await runImp('grants', name, '--json'),
    await runImp('ls', '--json'),
    await runImp('info', '--json'),
  ].join('\n');

  expect(shown).toContain(secret);
  expect(shown).not.toContain(token);
});

test('an API call gets the real token while the guest holds a placeholder', async () => {
  const placeholder = await runShellInImp(name, 'echo "$GH_TOKEN"');
  const env = await runShellInImp(name, 'env');

  expect(placeholder).toBe('imp-broker-placeholder');
  expect(env).not.toContain(token);

  const started = performance.now();

  const body = await runShellInImp(name, 'curl -sS --fail https://api.github.com/user');

  writeMetric('connectorsApiCallMs', Math.round(performance.now() - started));

  expect(JSON.parse(body)).toEqual({ authorized: true });
  expect(upstream.seen.at(-1)?.authorization).toBe(`Bearer ${token}`);
});

test('git push of a pack over 1 MB goes through the broker with Basic auth', async () => {
  const script = [
    'set -e',
    'rm -rf /root/e2e-push && mkdir /root/e2e-push && cd /root/e2e-push',
    'git init -q -b main',
    'git config user.email e2e@imp.test && git config user.name e2e',
    'head -c 3000000 /dev/urandom > blob',
    'git add blob && git commit -qm push',
    'git push -q https://github.com/acme/repo.git main 2>&1',
    'git rev-parse HEAD',
  ].join('\n');

  const started = performance.now();

  const pushed = await runShellInImp(name, script);

  writeMetric('connectorsGitPushMs', Math.round(performance.now() - started));

  const head = pushed.split('\n').at(-1) ?? '';

  const landed = await runChecked(['git', '-C', repo, 'rev-parse', 'main']);

  expect(landed.trim()).toBe(head);

  const auditJson = await runImp('audit', name, '--json');

  const audit = AuditSchema.parse(JSON.parse(auditJson));
  const pushes = audit.filter((entry) => entry.path.endsWith('/git-receive-pack'));

  // git probes with a small POST before it sends a large pack
  expect(pushes.length).toBeGreaterThan(0);
  expect(pushes.every((entry) => entry.host === 'github.com' && entry.status === 200)).toBe(true);
  expect(Math.max(...pushes.map((entry) => entry.requestBytes))).toBeGreaterThan(1_000_000);
});

test('hosts without a grant are tunnelled, and nothing inside can be reached', async () => {
  // the real example.com through a plain tunnel, its certificate the real one
  const outside = await runShellInImp(
    name,
    'curl -sS -o /dev/null -w "%{http_code}" https://example.com/',
  );

  expect(outside).toBe('200');

  const container = await runInContainer(['hostname', '-i']);

  const containerIp = container.stdout.trim().split(' ')[0] ?? '';

  // impd's own API, through the tunnel, by its container address
  const api = await runShellInImp(
    name,
    `curl -s -o /dev/null -w "%{http_code}" --max-time 20 -p -x "$HTTPS_PROXY" http://${containerIp}:7070/health || true`,
  );

  expect(api).not.toBe('200');

  // the neighbour's gateway (its /30's first address): the broker drops a
  // guest that is not on its own
  await createImp(neighbour, '--image', resolveImageName('base'), '--memory', '512m');

  const next = await requireImp(neighbour);

  const otherGateway = `10.66.${String(Math.floor((next.slot * 4) / 256))}.${String(((next.slot * 4) % 256) + 1)}`;

  const other = await runShellInImp(
    name,
    `curl -s -o /dev/null -w "%{http_code}" --max-time 20 -x http://${otherGateway}:7081 https://api.github.com/user || true`,
  );

  expect(other).toBe('000');

  await removeImps(neighbour);
});

test('a slept and woken guest holds no secret in memory and still gets the broker', async () => {
  const imp = await requireImp(name);

  await runImp('sleep', name);

  const mem = `/var/lib/imp/imps/${imp.id}/snapshot/mem`;

  const found = await runInContainer(['grep', '-c', '-a', token, mem]);

  expect(found.stdout.trim()).toBe('0');

  await holdImp(name);

  const body = await runShellInImp(name, 'curl -sS --fail https://api.github.com/user');

  expect(JSON.parse(body)).toEqual({ authorized: true });
});

test('a revoke stops the credential: the fake upstream sees nothing more', async () => {
  await runImp('revoke', name, secret);

  const before = upstream.seen.length;

  // with no grant, api.github.com is the real one, reached without a token
  await runShellInImp(name, 'curl -s -o /dev/null https://api.github.com/user || true');

  expect(upstream.seen).toHaveLength(before);
});
