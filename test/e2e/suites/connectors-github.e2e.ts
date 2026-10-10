import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  buildBrokerUpstreams,
  buildSlotGateway,
  readBrokerAudit,
  removeBrokerUpstreams,
  writeBrokerUpstreams,
} from '../lib/broker-upstreams';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, requireImp, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { readContainerGateway, runChecked, runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent, removeSecretIfPresent } from '../lib/reset-baseline';
import { startStubUpstream } from '../lib/start-stub-upstream';
import { readSuitePrefix } from '../lib/suites';
import { writeMetric } from '../lib/write-metric';

// The credential broker in a real guest (docs/guides/connectors.md): a stub
// github.com on this machine stands in for the real one, each test makes up
// its own token, and the checks look for it everywhere it must not be.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const gateway = await readContainerGateway();

  return { prefix: readSuitePrefix('connectors'), stack, client, gateway };
}

test('it takes a secret on stdin, never shows it back, gives a granted guest the real token behind a placeholder, and stops it on a revoke', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}a`;
  const secret = `${ctx.prefix}gh`;
  const token = `e2e-${randomUUID()}`;

  const upstream = await startStubUpstream(ctx.gateway, token);

  ctx.stack.defer(() => upstream.stop());

  await writeBrokerUpstreams(
    buildBrokerUpstreams(upstream.caPem, upstream.origin, ['github.com', 'api.github.com']),
  );

  ctx.stack.defer(() => removeBrokerUpstreams());

  await runImp('new', name, '--image', resolveImageName('base'), '--memory', '1g');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const added = await tryImp(['secret', 'add', secret, '--kind', 'github'], {
    stdin: `${token}\n`,
  });

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImp('grant', name, secret);

  const shown = [
    added.stdout,
    await runImp('secret', 'ls', '--json'),
    await runImp('grants', name, '--json'),
    await runImp('ls', '--json'),
    await runImp('info', '--json'),
  ].join('\n');

  expect(added.exitCode).toBe(0);
  expect(shown).toContain(secret);
  expect(shown).not.toContain(token);

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

  const placeholder = await runShellInImp(name, 'echo "$GH_TOKEN"');
  const env = await runShellInImp(name, 'env');

  const started = performance.now();

  const body = await runShellInImp(name, 'curl -sS --fail https://api.github.com/user');

  writeMetric('connectorsApiCallMs', Math.round(performance.now() - started));

  expect(proxy.trim()).toMatch(/^http:\/\/10\.66\.\d+\.\d+:7081$/v);
  expect(placeholder).toBe('imp-broker-placeholder');
  expect(env).not.toContain(token);
  expect(JSON.parse(body)).toStrictEqual({ authorized: true });
  expect(upstream.seen.at(-1)?.authorization).toBe(`Bearer ${token}`);

  await runImp('revoke', name, secret);

  const seenBefore = upstream.seen.length;

  // with no grant, api.github.com is the real one, reached without a token
  await runShellInImp(name, 'curl -s -o /dev/null https://api.github.com/user || true');

  const refused = await tryImp([
    'exec',
    name,
    '--require',
    'broker',
    '--',
    'touch',
    '/root/e2e-ungranted-ran',
  ]);

  const ran = await runShellInImp(name, 'test -e /root/e2e-ungranted-ran && echo ran || echo none');

  expect(upstream.seen).toHaveLength(seenBefore);

  expect(refused).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('the imp has no grant'),
  });

  expect(ran).toBe('none');
});

test('it pushes a git pack over 1 MB through the broker with Basic auth', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}push`;
  const secret = `${ctx.prefix}gh`;
  const token = `e2e-${randomUUID()}`;

  const upstream = await startStubUpstream(ctx.gateway, token);

  ctx.stack.defer(() => upstream.stop());

  const repo = await upstream.createRepo('acme/repo.git');

  await writeBrokerUpstreams(
    buildBrokerUpstreams(upstream.caPem, upstream.origin, ['github.com', 'api.github.com']),
  );

  ctx.stack.defer(() => removeBrokerUpstreams());

  await runImp('new', name, '--image', resolveImageName('base'), '--memory', '1g');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await ctx.client.secrets.add({ name: secret, kind: 'github', value: token });

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImp('grant', name, secret);

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

  const landed = await runChecked(['git', '-C', repo, 'rev-parse', 'main']);
  const audit = await readBrokerAudit(name);

  const pushes = audit.filter((entry) => entry.path.endsWith('/git-receive-pack'));

  expect(landed.trim()).toBe(pushed.split('\n').at(-1) ?? '');

  // git probes with a small POST before it sends a large pack
  expect(pushes.length).toBeGreaterThan(0);

  expect(pushes).toSatisfyAll(
    (entry: (typeof pushes)[number]) => entry.host === 'github.com' && entry.status === 200,
  );

  expect(Math.max(...pushes.map((entry) => entry.requestBytes))).toBeGreaterThan(1_000_000);
});

test('it tunnels hosts without a grant, and lets nothing inside be reached', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}tun`;
  const neighbour = `${ctx.prefix}next`;
  const secret = `${ctx.prefix}gh`;
  const token = `e2e-${randomUUID()}`;

  const upstream = await startStubUpstream(ctx.gateway, token);

  ctx.stack.defer(() => upstream.stop());

  await writeBrokerUpstreams(
    buildBrokerUpstreams(upstream.caPem, upstream.origin, ['github.com', 'api.github.com']),
  );

  ctx.stack.defer(() => removeBrokerUpstreams());

  await runImp('new', name, '--image', resolveImageName('base'), '--memory', '1g');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  // the broker's variables reach only an imp with a grant
  await ctx.client.secrets.add({ name: secret, kind: 'github', value: token });

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImp('grant', name, secret);
  await runImp('new', neighbour, '--image', resolveImageName('base'), '--memory', '512m');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, neighbour));

  await waitForExec(neighbour);

  // the real example.com through a plain tunnel, its certificate the real one
  const outside = await runShellInImp(
    name,
    'curl -sS -o /dev/null -w "%{http_code}" https://example.com/',
  );

  const container = await runInContainer(['hostname', '-i']);

  const containerIp = container.stdout.trim().split(' ')[0] ?? '';

  // impd's own API, through the tunnel, by its container address
  const api = await runShellInImp(
    name,
    `curl -s -o /dev/null -w "%{http_code}" --max-time 20 -p -x "$HTTPS_PROXY" http://${containerIp}:7070/health || true`,
  );

  // the neighbour's gateway: the broker drops a guest that is not on its own
  const next = await requireImp(neighbour);

  const other = await runShellInImp(
    name,
    `curl -s -o /dev/null -w "%{http_code}" --max-time 20 -x http://${buildSlotGateway(next.slot)}:7081 https://api.github.com/user || true`,
  );

  expect(outside).toBe('200');
  expect(api).not.toBe('200');
  expect(other).toBe('000');
});

test('it leaves no secret in the memory of a slept guest, which still gets the broker once woken', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}mem`;
  const secret = `${ctx.prefix}gh`;
  const token = `e2e-${randomUUID()}`;

  const upstream = await startStubUpstream(ctx.gateway, token);

  ctx.stack.defer(() => upstream.stop());

  await writeBrokerUpstreams(
    buildBrokerUpstreams(upstream.caPem, upstream.origin, ['github.com', 'api.github.com']),
  );

  ctx.stack.defer(() => removeBrokerUpstreams());

  await runImp('new', name, '--image', resolveImageName('base'), '--memory', '1g');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await ctx.client.secrets.add({ name: secret, kind: 'github', value: token });

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImp('grant', name, secret);

  // a call through the broker first, so the guest's memory has seen it work
  const before = await runShellInImp(name, 'curl -sS --fail https://api.github.com/user');
  const row = await requireImp(name);

  await runImp('sleep', name);

  const found = await runInContainer([
    'grep',
    '-c',
    '-a',
    token,
    `/var/lib/imp/imps/${row.id}/snapshot/mem`,
  ]);

  await holdImp(name);

  const after = await runShellInImp(name, 'curl -sS --fail https://api.github.com/user');

  expect(JSON.parse(before)).toStrictEqual({ authorized: true });
  expect(found.stdout.trim()).toBe('0');
  expect(JSON.parse(after)).toStrictEqual({ authorized: true });
});

test('it refuses an exec that requires the broker when the CA bundle step failed after a wake, and tries the step again on the next', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}ca`;
  const secret = `${ctx.prefix}gh`;
  const token = `e2e-${randomUUID()}`;

  const upstream = await startStubUpstream(ctx.gateway, token);

  ctx.stack.defer(() => upstream.stop());

  await writeBrokerUpstreams(
    buildBrokerUpstreams(upstream.caPem, upstream.origin, ['github.com', 'api.github.com']),
  );

  ctx.stack.defer(() => removeBrokerUpstreams());

  await runImp('new', name, '--image', resolveImageName('base'), '--memory', '1g');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await ctx.client.secrets.add({ name: secret, kind: 'github', value: token });

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImp('grant', name, secret);

  // /etc/imp as a file: the bundle step's mkdir fails at the next boot
  await runShellInImp(name, 'mv /etc/imp /etc/imp.e2e && touch /etc/imp');
  await runImp('sleep', name);

  const refused = await tryImp([
    'exec',
    name,
    '--require',
    'broker',
    '--',
    'touch',
    '/root/e2e-required-ran',
  ]);

  await runShellInImp(name, 'rm /etc/imp && mv /etc/imp.e2e /etc/imp');
  await holdImp(name);

  const ran = await runShellInImp(name, 'test -e /root/e2e-required-ran && echo ran || echo none');

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

  expect(refused).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toIncludeMultiple([
      'PRECONDITION_FAILED',
      'the broker CA bundle is not in this boot',
    ]),
  });

  expect(ran).toBe('none');
  expect(proxy).toContain(':7081');
});
