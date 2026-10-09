import { expect, test } from 'bun:test';
import { findImpByName } from '../db/imps';
import { buildStubOlderMoveTarget } from '../test-utils/build-stub-older-move-target';
import { createUbuntuImage, setupMoveHosts } from './test-moves';
import type { MoveHostsOptions } from './test-moves';

// two impds, the source's move routes reaching the target's in process
function setupTest(config: Readonly<MoveHostsOptions> = {}) {
  return setupMoveHosts(config);
}

test('it refuses a public imp a target that predates the policy, before any byte goes', async () => {
  const ctx = await setupTest({ hook: buildStubOlderMoveTarget('keepsPublicEgress') });

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.setPolicy({
    name: 'dev',
    policy: { mode: 'public', allow: [] },
  });

  const status = await ctx.runMove('dev', true);
  const imp = await findImpByName(ctx.source.db, 'dev');
  const landed = await findImpByName(ctx.target.db, 'dev');

  expect(status.error).toContain('predates the public egress policy');
  expect(status.sentBytes).toBe(0);
  expect(imp).toMatchObject({ state: 'running', moveState: null });
  expect(landed).toBeUndefined();
});

test('it lands a public imp public on a target that knows the policy', async () => {
  const ctx = await setupTest();

  await createUbuntuImage(ctx.source);
  await createUbuntuImage(ctx.target);

  await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await ctx.sourceApp.client.imps.setPolicy({
    name: 'dev',
    policy: { mode: 'public', allow: [] },
  });

  const status = await ctx.runMove('dev', true);
  const policy = await ctx.target.egress.readPolicy('dev');

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(policy).toStrictEqual({ mode: 'public', allow: [] });
});
