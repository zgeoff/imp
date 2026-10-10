import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import {
  buildBrokerUpstreams,
  readBrokerAudit,
  removeBrokerUpstreams,
  writeBrokerUpstreams,
} from '../lib/broker-upstreams';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, requireImp, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { readContainerGateway, runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent, removeSecretIfPresent } from '../lib/reset-baseline';
import { startStubUpstream } from '../lib/start-stub-upstream';
import { readSuitePrefix } from '../lib/suites';

// The broker's oauth and custom secrets (docs/guides/connectors.md), against
// the stub upstream on this machine, which stands in for every host here:
// api.oauth-e2e.test and auth.oauth-e2e.test, and svc.imp.internal over http.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const gateway = await readContainerGateway();

  return { prefix: readSuitePrefix('connectors'), stack, client, gateway };
}

test('it signs an oauth secret in, rotates its tokens on a forced refresh, refuses a websocket upgrade, and leaves no token in the guest', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}oauth`;
  const secret = `${ctx.prefix}oa`;

  const upstream = await startStubUpstream(ctx.gateway, `e2e-${randomUUID()}`);

  ctx.stack.defer(() => upstream.stop());

  await writeBrokerUpstreams(
    buildBrokerUpstreams(upstream.caPem, upstream.origin, [
      'api.oauth-e2e.test',
      'auth.oauth-e2e.test',
    ]),
  );

  ctx.stack.defer(() => removeBrokerUpstreams());

  await runImp('new', name, '--image', resolveImageName('base'), '--memory', '1g');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const added = await tryImp(
    [
      'secret',
      'add',
      secret,
      '--kind',
      'oauth',
      '--hosts',
      'api.oauth-e2e.test',
      '--token-url',
      'https://auth.oauth-e2e.test/oauth/token',
      '--client-id',
      upstream.oauth.clientId,
      '--token-format',
      'json',
    ],
    { stdin: `${upstream.oauth.firstRefreshToken}\n` },
  );

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImp('grant', name, secret);

  const MeSchema = z.object({ generation: z.number(), authorized: z.boolean() });

  const signedIn = await runShellInImp(
    name,
    'curl -sS --fail https://api.oauth-e2e.test/oauth-e2e/me',
  );

  const listed = await runImp('secret', 'ls');

  expect(added).toStrictEqual({
    exitCode: 0,
    stdout: expect.toInclude('ready until'),
    stderr: expect.toInclude(`${secret} signed in`),
  });

  expect(MeSchema.parse(JSON.parse(signedIn))).toStrictEqual({ generation: 1, authorized: true });
  expect(listed).toContain(secret);
  expect(listed).toContain('ready until');
  expect(listed).not.toContain('e2e-refresh');
  expect(listed).not.toContain('e2e-access');

  // runImp throws on a failed refresh, with its stderr
  await runImp('secret', 'refresh', secret);

  const rotated = await runShellInImp(
    name,
    'curl -sS --fail https://api.oauth-e2e.test/oauth-e2e/me',
  );

  // the first refresh token is dead at the endpoint, and impd used each once
  const [first, second] = upstream.oauth.refreshTokens();

  expect(MeSchema.parse(JSON.parse(rotated))).toStrictEqual({ generation: 2, authorized: true });
  expect(upstream.oauth.exchange(first ?? '')).toBe(400);
  expect(upstream.oauth.refreshTokens()).toHaveLength(3);
  expect(second).toBeString();

  const upgrade = await runShellInImp(
    name,
    "curl -sS -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' https://api.oauth-e2e.test/oauth-e2e/me",
  );

  expect(upgrade).toContain('426');
  expect(upgrade).toContain('websocket upgrades are not supported through the broker');

  const tokens = [...upstream.oauth.accessTokens(), ...upstream.oauth.refreshTokens()];

  const env = await runShellInImp(name, 'env');

  // the disk, by the tokens' common prefixes: a token on a command line
  // would sit in the guest's memory, which the check below looks through
  const onDisk = await runShellInImp(
    name,
    `grep -rIl -F -e e2e-access- -e e2e-refresh- / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -5; true`,
  );

  const row = await requireImp(name);

  await runImp('sleep', name);

  const inMemory = await Promise.all(
    tokens.map(async (value) => {
      const found = await runInContainer([
        'grep',
        '-c',
        '-a',
        value,
        `/var/lib/imp/imps/${row.id}/snapshot/mem`,
      ]);

      return found.stdout.trim();
    }),
  );

  await holdImp(name);

  const woken = await runShellInImp(
    name,
    'curl -sS --fail https://api.oauth-e2e.test/oauth-e2e/me',
  );

  expect(tokens.length).toBeGreaterThan(4);
  expect(tokens).toSatisfyAll((value: string) => !env.includes(value));
  expect(onDisk.trim()).toBe('');
  expect(inMemory).toSatisfyAll((count: string) => count === '0');
  expect(MeSchema.parse(JSON.parse(woken)).authorized).toBeTrue();
});

test('it reaches a service with no public name over plain http through a secret with an upstream', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}svc`;
  const secret = `${ctx.prefix}up`;
  const token = `e2e-${randomUUID()}`;

  const upstream = await startStubUpstream(ctx.gateway, token);

  ctx.stack.defer(() => upstream.stop());

  await runImp('new', name, '--image', resolveImageName('base'), '--memory', '1g');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const added = await tryImp(
    [
      'secret',
      'add',
      secret,
      '--kind',
      'custom',
      '--hosts',
      'svc.imp.internal',
      '--upstream',
      upstream.plainOrigin,
    ],
    { stdin: `${token}\n` },
  );

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImp('grant', name, secret);

  const seenBefore = upstream.seen.length;

  const body = await runShellInImp(
    name,
    'OP_CONNECT_TOKEN=imp-broker-placeholder; curl -sS --fail -H "Authorization: Bearer $OP_CONNECT_TOKEN" https://svc.imp.internal/svc-e2e/me',
  );

  const audit = await readBrokerAudit(name);
  const listed = await runImp('secret', 'ls');

  expect(added).toStrictEqual({
    exitCode: 0,
    stdout: expect.toInclude(upstream.plainOrigin),
    stderr: expect.toBeString(),
  });

  expect(JSON.parse(body)).toStrictEqual({ authorized: true });

  expect(upstream.seen.slice(seenBefore)).toStrictEqual([
    { method: 'GET', path: '/svc-e2e/me', authorization: `Bearer ${token}` },
  ]);

  expect(audit.find((entry) => entry.host === 'svc.imp.internal')).toMatchObject({
    path: '/svc-e2e/me',
    status: 200,
    secret,
  });

  expect(listed).toContain(`svc.imp.internal -> ${upstream.plainOrigin}`);
});
