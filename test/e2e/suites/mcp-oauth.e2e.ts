import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import * as z from 'zod';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, readImpEnv, runImp, tryImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { instance, runDevScript } from '../lib/instance';
import {
  RouteTokensSchema,
  buildPkceChallenge,
  openRouteMcp,
  parseApprovalPage,
  runSignIn,
  sendForm,
  sendMcp,
} from '../lib/oauth-route';
import { registerRemoval } from '../lib/register-removal';
import {
  removeImpIfPresent,
  removeOAuthClientIfPresent,
  removeTokenIfPresent,
} from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// The public MCP route (docs/guides/mcp.md#public-route) on plain http on
// loopback, as tests alone may use. Each test reboots the instance with the
// route on, and back; a named token approves each sign-in with the CLI.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  const origin = `http://127.0.0.1:${String(7071 + instance.portOffset)}`;

  // the redirect URI's server: it takes the code a sign-in sends back
  const catcher = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('signed in'),
  });

  stack.defer(() => catcher.stop(true));

  return {
    prefix: readSuitePrefix('mcp-oauth'),
    stack,
    client,
    origin,
    redirect: `http://127.0.0.1:${String(catcher.port)}/callback`,
  };
}

test('it serves the route’s discovery documents and nothing private', async () => {
  const ctx = await setupTest();

  await runDevScript('reboot', instance, { IMP_MCP_PUBLIC_URL: ctx.origin });

  ctx.stack.defer(() => runDevScript('reboot'));

  const metadata = await fetch(`${ctx.origin}/.well-known/oauth-authorization-server`);
  const resource = await fetch(`${ctx.origin}/.well-known/oauth-protected-resource/mcp`);
  const unauthorized = await fetch(`${ctx.origin}/mcp`, { method: 'POST' });
  const issuer: unknown = await metadata.json();
  const protectedResource: unknown = await resource.json();
  const rpc = await fetch(`${ctx.origin}/rpc/system/info`);
  const health = await fetch(`${ctx.origin}/health`);
  const ui = await fetch(`${ctx.origin}/ui/`);
  const env = await readImpEnv();

  // the instance's root token is no way in
  const withRoot = await fetch(`${ctx.origin}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env['IMP_TOKEN'] ?? ''}` },
  });

  expect(issuer).toMatchObject({
    issuer: ctx.origin,
    code_challenge_methods_supported: ['S256'],
  });

  expect(protectedResource).toMatchObject({
    resource: `${ctx.origin}/mcp`,
    authorization_servers: [ctx.origin],
  });

  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata=');
  expect([rpc.status, health.status, ui.status]).toStrictEqual([404, 404, 404]);
  expect(withRoot.status).toBe(401);
});

test('it signs a client in on an approval from the CLI, and the grant lists the tools its scope allows and runs a command in its imps', async () => {
  const ctx = await setupTest();

  const box = `${ctx.prefix}box`;
  const clientName = `${ctx.prefix}conn`;
  const approver = `${ctx.prefix}approver`;

  await runDevScript('reboot', instance, { IMP_MCP_PUBLIC_URL: ctx.origin });

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', box, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, box));

  await waitForExec(box);

  const added = await ctx.client.oauth.clients.add({
    name: clientName,
    redirectUris: [ctx.redirect],
  });

  registerRemoval(ctx.stack, config.keep, () => removeOAuthClientIfPresent(ctx.client, clientName));

  const token = await ctx.client.tokens.create({
    name: approver,
    scope: 'exec',
    imps: [`${ctx.prefix}*`],
  });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, approver));

  const verifier = randomBytes(32).toString('base64url');

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: added.clientId,
    redirect_uri: ctx.redirect,
    code_challenge: buildPkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'e2e',
    scope: 'read exec',
    resource: `${ctx.origin}/mcp`,
  });

  const opened = await fetch(`${ctx.origin}/oauth/authorize?${query.toString()}`);
  const page = await opened.text();

  const approval = parseApprovalPage(page);

  expect(opened.status).toBe(200);
  expect(opened.headers.get('referrer-policy')).toBe('same-origin');

  const approved = await tryImp(['oauth', 'approve', approval.code, '--scope', 'exec', '--yes'], {
    token: token.secret,
  });

  expect(approved.exitCode).toBe(0);
  expect(approved.stderr).toContain(`client:       ${clientName}`);
  expect(approved.stderr).toContain(`returns to:   ${ctx.redirect}`);

  // as a browser posts it from a page whose referrer policy is same-origin
  // or stricter: Origin null, and Sec-Fetch-Site it sets itself
  const allowed = await sendForm(
    `${ctx.origin}/oauth/authorize`,
    { id: approval.id, signature: approval.signature, action: 'allow' },
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
  );

  const location = new URL(allowed.headers.get('location') ?? '');

  // the browser follows the redirect to the client
  const caught = await fetch(location);

  expect(allowed.status).toBe(302);
  expect(allowed.headers.get('referrer-policy')).toBe('no-referrer');
  expect(location.searchParams.get('iss')).toBe(ctx.origin);
  expect(location.searchParams.get('state')).toBe('e2e');
  expect(caught.status).toBe(200);

  const exchanged = await sendForm(`${ctx.origin}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: added.clientId,
    code: location.searchParams.get('code') ?? '',
    redirect_uri: ctx.redirect,
    code_verifier: verifier,
    resource: `${ctx.origin}/mcp`,
  });

  const exchangedBody: unknown = await exchanged.json();

  const tokens = RouteTokensSchema.parse(exchangedBody);

  expect(tokens.scope).toBe('read exec');

  const session = await openRouteMcp(ctx.origin, tokens.access_token);
  const listed = await sendMcp(ctx.origin, tokens.access_token, session, 'tools/list');

  const ran = await sendMcp(ctx.origin, tokens.access_token, session, 'tools/call', {
    name: 'imp_exec',
    arguments: { name: box, command: 'echo from-the-route' },
  });

  const grants = await runImp('oauth', 'grant', 'ls');

  const tool = z.object({ name: z.string() });

  const names = z
    .object({ result: z.object({ tools: z.array(tool) }) })
    .parse(listed.body)
    .result.tools.map((entry) => entry.name);

  expect(names).toContain('imp_exec');
  expect(names).not.toContain('imp_create');
  expect(JSON.stringify(ran.body)).toContain('from-the-route');
  expect(grants).toContain(clientName);
  expect(grants).toContain(approver);
});

test('it rotates a refresh, and ends the grant when a spent refresh token comes again', async () => {
  const ctx = await setupTest();

  const clientName = `${ctx.prefix}conn`;
  const approver = `${ctx.prefix}approver`;

  await runDevScript('reboot', instance, { IMP_MCP_PUBLIC_URL: ctx.origin });

  ctx.stack.defer(() => runDevScript('reboot'));

  const added = await ctx.client.oauth.clients.add({
    name: clientName,
    redirectUris: [ctx.redirect],
  });

  registerRemoval(ctx.stack, config.keep, () => removeOAuthClientIfPresent(ctx.client, clientName));

  const token = await ctx.client.tokens.create({
    name: approver,
    scope: 'exec',
    imps: [`${ctx.prefix}*`],
  });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, approver));

  const first = await runSignIn({
    origin: ctx.origin,
    clientId: added.clientId,
    redirect: ctx.redirect,
    approverToken: token.secret,
    scope: 'read',
  });

  const refresh = {
    grant_type: 'refresh_token',
    client_id: added.clientId,
    refresh_token: first.refresh_token,
  };

  const rotated = await sendForm(`${ctx.origin}/oauth/token`, refresh);
  const rotatedBody: unknown = await rotated.json();
  const replayed = await sendForm(`${ctx.origin}/oauth/token`, refresh);
  const replayBody: unknown = await replayed.json();

  const second = RouteTokensSchema.parse(rotatedBody);

  const after = await sendMcp(ctx.origin, second.access_token, '', 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e' },
  });

  expect(second.scope).toBe('read');
  expect(replayBody).toMatchObject({ error: 'invalid_grant' });
  expect(after.status).toBe(401);
});

test('it stops the command a grant runs when the approving token goes, then answers 401', async () => {
  const ctx = await setupTest();

  const box = `${ctx.prefix}box`;
  const clientName = `${ctx.prefix}conn`;
  const approver = `${ctx.prefix}approver`;

  await runDevScript('reboot', instance, { IMP_MCP_PUBLIC_URL: ctx.origin });

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', box, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, box));

  await waitForExec(box);

  const added = await ctx.client.oauth.clients.add({
    name: clientName,
    redirectUris: [ctx.redirect],
  });

  registerRemoval(ctx.stack, config.keep, () => removeOAuthClientIfPresent(ctx.client, clientName));

  const token = await ctx.client.tokens.create({
    name: approver,
    scope: 'exec',
    imps: [`${ctx.prefix}*`],
  });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, approver));

  const tokens = await runSignIn({
    origin: ctx.origin,
    clientId: added.clientId,
    redirect: ctx.redirect,
    approverToken: token.secret,
    scope: 'exec',
  });

  const session = await openRouteMcp(ctx.origin, tokens.access_token);

  const call = sendMcp(ctx.origin, tokens.access_token, session, 'tools/call', {
    name: 'imp_exec',
    arguments: { name: box, command: 'sleep 120', timeoutSeconds: 180 },
  });

  // the command runs in the guest before the token goes
  await waitFor('the command to start', async () => {
    const processes = await runImp('exec', box, '--', 'ps');

    if (!processes.includes('sleep 120')) {
      throw new Error('no sleep 120 yet');
    }
  });

  const started = Date.now();

  await runImp('token', 'rm', approver);

  const [settled] = await Promise.allSettled([call]);

  const elapsedMs = Date.now() - started;

  // a stream that ended with no result, or none at all
  const outcome =
    settled?.status === 'fulfilled' && JSON.stringify(settled.value.body).includes('"result"')
      ? 'answered'
      : 'dropped';

  const after = await sendMcp(ctx.origin, tokens.access_token, session, 'ping');
  const processes = await runImp('exec', box, '--', 'ps');

  expect(outcome).toBe('dropped');

  // the stream closed long before the command's 120 s
  expect(elapsedMs).toBeLessThan(30_000);
  expect(after.status).toBe(401);
  expect(processes).not.toContain('sleep 120');
}, 120_000);

test('it answers 429 to sign-ins past the burst', async () => {
  const ctx = await setupTest();

  const clientName = `${ctx.prefix}conn`;

  await runDevScript('reboot', instance, { IMP_MCP_PUBLIC_URL: ctx.origin });

  ctx.stack.defer(() => runDevScript('reboot'));

  const added = await ctx.client.oauth.clients.add({
    name: clientName,
    redirectUris: [ctx.redirect],
  });

  registerRemoval(ctx.stack, config.keep, () => removeOAuthClientIfPresent(ctx.client, clientName));

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: added.clientId,
    redirect_uri: ctx.redirect,
    code_challenge: buildPkceChallenge(randomBytes(32).toString('base64url')),
    code_challenge_method: 'S256',
  });

  // twelve, one after another
  const statuses: number[] = [];

  for (let index = 0; index < 12; index += 1) {
    const response = await fetch(`${ctx.origin}/oauth/authorize?${query.toString()}`);

    statuses.push(response.status);
  }

  expect(statuses).toContain(429);
});
