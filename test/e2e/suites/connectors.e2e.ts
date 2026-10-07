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
import { instance, readContainerGateway, runChecked, runInContainer } from '../lib/instance';
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

// the oauth secret's fake hosts, both served by the fake upstream
const oauthSecret = `${prefix}oa`;
const oauthApiHost = 'api.oauth-e2e.test';
const oauthTokenHost = 'auth.oauth-e2e.test';

// a custom secret for a name with no DNS, sent to the fake upstream over http
const upstreamSecret = `${prefix}up`;
const upstreamHost = 'svc.imp.internal';

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

beforeAll(async () => {
  const gateway = await readContainerGateway();

  upstream = await startFakeUpstream(gateway, token);
  repo = await upstream.createRepo('acme/repo.git');

  writeFileSync(
    upstreamsFile,
    JSON.stringify({
      ca: upstream.caPem,
      upstreams: {
        'github.com': upstream.origin,
        'api.github.com': upstream.origin,
        [oauthApiHost]: upstream.origin,
        [oauthTokenHost]: upstream.origin,
      },
    }),
  );

  await tryImp(['secret', 'rm', secret]);
  await tryImp(['secret', 'rm', oauthSecret]);
  await tryImp(['secret', 'rm', upstreamSecret]);
  await createImp(name, '--image', resolveImageName('base'), '--memory', '1g');
  await holdImp(name);
}, 300_000);

afterAll(async () => {
  rmSync(upstreamsFile, { force: true });

  await tryImp(['secret', 'rm', secret]);
  await tryImp(['secret', 'rm', oauthSecret]);
  await tryImp(['secret', 'rm', upstreamSecret]);

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

test('an exec that requires the broker starts with its variables', async () => {
  const proxy = await runImp(
    'exec',
    name,
    '--require',
    'broker',
    '--',
    'sh',
    '-c',
    'echo "$HTTPS_PROXY"',
  );

  expect(proxy.trim()).toMatch(/^http:\/\/10\.66\.\d+\.\d+:7081$/u);
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

// whether the command an exec was refused for ran after all
function checkRan(marker: string): Promise<string> {
  return runShellInImp(name, `test -e ${marker} && echo ran || echo none`);
}

test('a failed CA bundle step after a wake refuses an exec that requires the broker', async () => {
  const marker = '/root/e2e-required-ran';

  // /etc/imp as a file: the bundle step's mkdir fails at the next boot
  await runShellInImp(name, `rm -f ${marker}; mv /etc/imp /etc/imp.e2e && touch /etc/imp`);
  await runImp('sleep', name);

  const refused = await tryImp(['exec', name, '--require', 'broker', '--', 'touch', marker]);

  await runShellInImp(name, 'rm /etc/imp && mv /etc/imp.e2e /etc/imp');
  await holdImp(name);

  expect(refused.exitCode).toBe(255);
  expect(refused.stderr).toContain('PRECONDITION_FAILED');
  expect(refused.stderr).toContain('the broker CA bundle is not in this boot');

  const ran = await checkRan(marker);

  expect(ran).toBe('none');

  // the next exec tries the step again
  const proxy = await runImp(
    'exec',
    name,
    '--require',
    'broker',
    '--',
    'sh',
    '-c',
    'echo "$HTTPS_PROXY"',
  );

  expect(proxy).toContain(':7081');
});

test('a revoke stops the credential: the fake upstream sees nothing more', async () => {
  await runImp('revoke', name, secret);

  const before = upstream.seen.length;

  // with no grant, api.github.com is the real one, reached without a token
  await runShellInImp(name, 'curl -s -o /dev/null https://api.github.com/user || true');

  expect(upstream.seen).toHaveLength(before);
});

test('without a grant, an exec that requires the broker runs nothing', async () => {
  const marker = '/root/e2e-ungranted-ran';

  const refused = await tryImp(['exec', name, '--require', 'broker', '--', 'touch', marker]);

  expect(refused.exitCode).toBe(255);
  expect(refused.stderr).toContain('the imp has no grant');

  const ran = await checkRan(marker);

  expect(ran).toBe('none');
});

const MeSchema = z.object({ generation: z.number(), authorized: z.boolean() });

// the oauth API as the guest sees it
async function readOAuthMe(): Promise<z.infer<typeof MeSchema>> {
  const body = await runShellInImp(name, `curl -sS --fail https://${oauthApiHost}/oauth-e2e/me`);

  return MeSchema.parse(JSON.parse(body));
}

test('an oauth secret signs in, and the guest reaches the API with the access token', async () => {
  const added = await tryImp(
    [
      'secret',
      'add',
      oauthSecret,
      '--kind',
      'oauth',
      '--hosts',
      oauthApiHost,
      '--token-url',
      `https://${oauthTokenHost}/oauth/token`,
      '--client-id',
      upstream.oauth.clientId,
      '--token-format',
      'json',
    ],
    { stdin: `${upstream.oauth.firstRefreshToken}\n` },
  );

  expect(added.exitCode).toBe(0);
  expect(added.stderr).toContain(`${oauthSecret} signed in`);
  expect(added.stdout).toContain('ready until');

  await runImp('grant', name, oauthSecret);

  const me = await readOAuthMe();

  expect(me).toEqual({ generation: 1, authorized: true });

  const listed = await runImp('secret', 'ls');

  expect(listed).toContain(oauthSecret);
  expect(listed).toContain('ready until');
  expect(listed).not.toContain('e2e-refresh');
  expect(listed).not.toContain('e2e-access');
});

test('a forced refresh rotates the tokens, and the next request carries the new one', async () => {
  const refreshed = await tryImp(['secret', 'refresh', oauthSecret]);

  expect(refreshed.exitCode).toBe(0);

  const me = await readOAuthMe();

  expect(me).toEqual({ generation: 2, authorized: true });

  // the first refresh token is dead at the endpoint, and impd used each once
  const [first, second] = upstream.oauth.refreshTokens();

  expect(upstream.oauth.exchange(first ?? '')).toBe(400);
  expect(upstream.oauth.refreshTokens()).toHaveLength(3);
  expect(second).toBeDefined();
});

test('a websocket upgrade to a granted host is answered 426 at once', async () => {
  const answer = await runShellInImp(
    name,
    `curl -sS -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' https://${oauthApiHost}/oauth-e2e/me`,
  );

  expect(answer).toContain('426');
  expect(answer).toContain('websocket upgrades are not supported through the broker');
});

test('a secret with an upstream reaches a service with no public name over plain http', async () => {
  const added = await tryImp(
    [
      'secret',
      'add',
      upstreamSecret,
      '--kind',
      'custom',
      '--hosts',
      upstreamHost,
      '--upstream',
      upstream.plainOrigin,
    ],
    { stdin: `${token}\n` },
  );

  expect(added.exitCode).toBe(0);
  expect(added.stdout).toContain(upstream.plainOrigin);

  await runImp('grant', name, upstreamSecret);

  const before = upstream.seen.length;

  const body = await runShellInImp(
    name,
    `OP_CONNECT_TOKEN=imp-broker-placeholder; curl -sS --fail -H "Authorization: Bearer $OP_CONNECT_TOKEN" https://${upstreamHost}/svc-e2e/me`,
  );

  expect(JSON.parse(body)).toEqual({ authorized: true });

  expect(upstream.seen.slice(before)).toEqual([
    { method: 'GET', path: '/svc-e2e/me', authorization: `Bearer ${token}` },
  ]);

  const auditJson = await runImp('audit', name, '--json');

  const audit = AuditSchema.parse(JSON.parse(auditJson));
  const row = audit.find((entry) => entry.host === upstreamHost);

  expect(row).toMatchObject({ path: '/svc-e2e/me', status: 200, secret: upstreamSecret });

  const listed = await runImp('secret', 'ls');

  expect(listed).toContain(`${upstreamHost} -> ${upstream.plainOrigin}`);
});

test('no oauth token is in the guest: not its environment, disk or memory', async () => {
  const tokens = [...upstream.oauth.accessTokens(), ...upstream.oauth.refreshTokens()];

  expect(tokens.length).toBeGreaterThan(4);

  const env = await runShellInImp(name, 'env');

  for (const value of tokens) {
    expect(env).not.toContain(value);
  }

  // the disk, by the tokens' common prefixes: a token on a command line
  // would sit in the guest's memory, which the check below looks through
  const onDisk = await runShellInImp(
    name,
    `grep -rIl -F -e e2e-access- -e e2e-refresh- / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -5; true`,
  );

  expect(onDisk.trim()).toBe('');

  const imp = await requireImp(name);

  await runImp('sleep', name);

  const mem = `/var/lib/imp/imps/${imp.id}/snapshot/mem`;

  for (const value of tokens) {
    const found = await runInContainer(['grep', '-c', '-a', value, mem]);

    expect(found.stdout.trim()).toBe('0');
  }

  await holdImp(name);

  const me = await readOAuthMe();

  expect(me.authorized).toBe(true);
});
