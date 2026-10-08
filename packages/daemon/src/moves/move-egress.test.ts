import { expect, test } from 'bun:test';
import { findImpByName } from '../db/imps';
import { MOVE_PATHS, MoveOfferReplySchema } from './move-header';
import { createUbuntuImage, setupMoveHosts } from './test-moves';
import type { FetchHook } from './test-moves';

// An offer reply as a target from before the public egress policy answers it
async function removeKeepsPublic(request: Request, forward: () => Promise<Response>) {
  const response = await forward();

  if (!request.url.endsWith(MOVE_PATHS.offer)) {
    return response;
  }

  const body: unknown = await response.json();

  const { keepsPublicEgress: _dropped, ...older } = MoveOfferReplySchema.parse(body);

  return Response.json(older);
}

async function setupEgressMove(hook?: FetchHook) {
  const hosts = await setupMoveHosts({ ...(hook !== undefined && { hook }) });

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  await hosts.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await hosts.sourceApp.client.imps.setPolicy({
    name: 'dev',
    policy: { mode: 'public', allow: [] },
  });

  return hosts;
}

test('a public imp is refused a target that predates the policy, before any byte goes', async () => {
  const ctx = await setupEgressMove(removeKeepsPublic);
  const status = await ctx.runMove('dev', true);
  const imp = await findImpByName(ctx.source.db, 'dev');
  const landed = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('predates the public egress policy');
  expect(status.sentBytes).toBe(0);
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(landed).toBeUndefined();
});

test('a public imp lands public on a target that knows the policy', async () => {
  const ctx = await setupEgressMove();
  const status = await ctx.runMove('dev', true);
  const policy = await ctx.target.egress.readPolicy('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(policy).toEqual({ mode: 'public', allow: [] });
});
