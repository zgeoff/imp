import { expect, test } from 'bun:test';
import { findImpByName, listImps, updateImpMove } from '../db/imps';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';
import { createNetworkService } from './network-service';

// web in slot 0 and db in slot 1, both on lab
async function setupNetwork(runNft?: (script: string) => Promise<void>) {
  const options = runNft === undefined ? {} : { runNft };

  const ctx = await setupImpTest(options);

  await ctx.createTestImage('base');

  const client = buildTestApp(ctx, ctx).client;

  await client.networks.create({ name: 'lab' });
  await client.imps.create({ name: 'web', networks: ['lab'] });
  await client.imps.create({ name: 'db' });
  await client.networks.join({ network: 'lab', name: 'db' });

  return Object.assign(ctx, { client });
}

// by imp name
const LAB = 'elements = { "imp1" . 10.66.0.6, "imp0" . 10.66.0.2 }';

test('the imps on a network are in its set, and a second join changes nothing', async () => {
  await using ctx = await setupNetwork();

  expect(ctx.nftScripts.at(-1)).toContain(LAB);

  const again = await ctx.client.networks.join({ network: 'lab', name: 'db' });
  const networks = await ctx.client.networks.list();

  expect(again.imps).toEqual(['db', 'web']);
  expect(networks.map((network) => [network.name, network.imps])).toEqual([['lab', ['db', 'web']]]);
});

test("a leave takes the imp out of the set and drops the pair's flows", async () => {
  await using ctx = await setupNetwork();

  const left = await ctx.client.networks.leave({ network: 'lab', name: 'db' });

  expect(left.imps).toEqual(['web']);
  expect(ctx.nftScripts.at(-1)).toContain('elements = { "imp0" . 10.66.0.2 }');
  expect(ctx.flushedPairs).toEqual(['10.66.0.2 10.66.0.6']);

  // not on it any more: nothing to part
  await ctx.client.networks.leave({ network: 'lab', name: 'db' });

  expect(ctx.flushedPairs).toEqual(['10.66.0.2 10.66.0.6']);
});

test('a pair that still shares another network keeps its flows', async () => {
  await using ctx = await setupNetwork();

  await ctx.client.networks.create({ name: 'ops' });
  await ctx.client.networks.join({ network: 'ops', name: 'web' });
  await ctx.client.networks.join({ network: 'ops', name: 'db' });
  await ctx.client.networks.delete({ name: 'lab' });

  expect(ctx.flushedPairs).toEqual([]);

  await ctx.client.networks.delete({ name: 'ops' });

  expect(ctx.flushedPairs).toEqual(['10.66.0.2 10.66.0.6']);
  expect(ctx.nftScripts.at(-1)).not.toContain('@net0');
});

test('a create on a network that does not exist leaves no imp', async () => {
  await using ctx = await setupNetwork();

  const error = await readRejection(ctx.client.imps.create({ name: 'api', networks: ['nope'] }));
  const imps = await listImps(ctx.db);

  expect(error).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'network', name: 'nope' } });
  expect(imps.map((imp) => imp.name)).toEqual(['db', 'web']);
});

test('a token limited to some imps cannot put one on a network', async () => {
  await using ctx = await setupNetwork();

  const created = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const limited = buildTestApp(ctx, ctx, created.secret).client;

  const errors = [
    await readRejection(limited.imps.create({ name: 'dev-a', networks: ['lab'] })),
    await readRejection(limited.networks.join({ network: 'lab', name: 'dev-a' })),
  ];

  const networks = await limited.networks.list();

  expect(errors).toEqual([
    expect.objectContaining({ code: 'FORBIDDEN' }),
    expect.objectContaining({ code: 'FORBIDDEN' }),
  ]);

  expect(networks.map((network) => network.imps)).toEqual([[]]);
});

test('a table nft refuses puts the membership back', async () => {
  const state = { refuse: false };

  await using ctx = await setupNetwork(() => {
    const result = state.refuse ? Promise.reject(new Error('nft exited 1')) : Promise.resolve();

    return result;
  });

  state.refuse = true;

  const error = await readRejection(ctx.client.networks.leave({ network: 'lab', name: 'db' }));
  const networks = await ctx.client.networks.list();

  expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(networks[0]?.imps).toEqual(['db', 'web']);
  expect(ctx.flushedPairs).toEqual([]);
});

test("a destroyed imp leaves its networks' sets before its row goes", async () => {
  await using ctx = await setupNetwork();

  await ctx.client.imps.destroy({ name: 'db' });

  const networks = await ctx.client.networks.list();

  expect(ctx.nftScripts.at(-1)).toContain('elements = { "imp0" . 10.66.0.2 }');
  expect(networks[0]?.imps).toEqual(['web']);
});

test('a fork is on no network: a join is a choice made for each imp', async () => {
  await using ctx = await setupNetwork();

  await ctx.client.imps.fork({ source: 'web', name: 'copy' });

  const networks = await ctx.client.networks.list();

  expect(networks[0]?.imps).toEqual(['db', 'web']);
});

test('a join that puts a box imp next to an open one warns, from either side', async () => {
  await using ctx = await setupNetwork();

  await ctx.client.imps.setPolicy({ name: 'db', policy: { mode: 'box', allow: [] } });
  await ctx.client.networks.leave({ network: 'lab', name: 'db' });

  const boxJoins = await ctx.client.networks.join({ network: 'lab', name: 'db' });

  await ctx.client.networks.leave({ network: 'lab', name: 'web' });

  const openJoins = await ctx.client.networks.join({ network: 'lab', name: 'web' });

  await ctx.client.imps.setPolicy({ name: 'web', policy: { mode: 'none', allow: [] } });

  const sameJoins = await ctx.client.networks.join({ network: 'lab', name: 'web' });

  expect(boxJoins.warning).toContain('web on lab is open and can relay for it');
  expect(openJoins.warning).toContain('web is open, so db on lab can reach anything through it');
  expect(sameJoins.warning).toBeNull();
});

test('a net rm that nft refuses puts back every member, the latest join included', async () => {
  const state = { refuse: false };

  await using ctx = await setupNetwork(() => {
    const result = state.refuse ? Promise.reject(new Error('nft exited 1')) : Promise.resolve();

    return result;
  });

  state.refuse = true;

  const error = await readRejection(ctx.client.networks.delete({ name: 'lab' }));

  state.refuse = false;

  const networks = await ctx.client.networks.list();

  expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(networks.map((network) => [network.name, network.imps])).toEqual([['lab', ['db', 'web']]]);
});

test('a restore makes its missing networks, and removes them again when it fails', async () => {
  await using ctx = await setupNetwork();

  const networks = createNetworkService({ db: ctx.db, egress: ctx.egress });

  const written = await networks.writeMissingNetworks(['lab', 'new']);
  const made = await ctx.client.networks.list();

  await networks.removeEmptyNetworks(written.created);

  const after = await ctx.client.networks.list();

  expect(written.created).toEqual(['new']);
  expect(made.map((network) => network.name)).toEqual(['lab', 'new']);
  expect(after.map((network) => network.name)).toEqual(['lab']);
});

test("a policy change that mixes a network gets the same warning, for each of the imp's networks", async () => {
  await using ctx = await setupNetwork();

  const before = await ctx.client.networks.warnings({ name: 'db' });

  await ctx.client.imps.setPolicy({ name: 'db', policy: { mode: 'none', allow: [] } });

  const after = await ctx.client.networks.warnings({ name: 'db' });
  const missing = await readRejection(ctx.client.networks.warnings({ name: 'nope' }));

  expect(before).toEqual([]);

  expect(after).toEqual([
    'db is none, but web on lab is open and can relay for it: a box or none imp trusts its open peers',
  ]);

  expect(missing).toMatchObject({ code: 'NOT_FOUND' });
});

test('an imp a move marked cannot join a network', async () => {
  await using ctx = await setupNetwork();

  const imp = await findImpByName(ctx.db, 'web');

  await updateImpMove(ctx.db, imp?.id ?? '', 'sending');

  const refused = await readRejection(ctx.client.networks.join({ network: 'lab', name: 'web' }));

  expect(refused).toMatchObject({ code: 'MOVING' });
});
