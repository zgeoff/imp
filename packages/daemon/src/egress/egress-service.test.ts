import { expect, test } from 'bun:test';
import { findImpByName } from '../db/imps';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';

async function setupEgress(runNft?: (script: string) => Promise<void>) {
  const options = runNft === undefined ? {} : { runNft };

  const ctx = await setupImpTest(options);

  await ctx.createTestImage('base');

  return ctx;
}

test('a new imp is in the table, with its policy, before its tap comes up', async () => {
  // the taps that were up when each script ran
  const holder: { taps: readonly string[] } = { taps: [] };
  const seen: { script: string; taps: readonly string[] }[] = [];

  await using ctx = await setupEgress((script) => {
    seen.push({ script, taps: [...holder.taps] });

    return Promise.resolve();
  });

  holder.taps = ctx.taps;

  await ctx.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });

  const first = seen.find((entry) => entry.script.includes('chain slot0'));

  expect(first?.taps).toEqual([]);
  expect(first?.script).toContain('ip saddr != 10.66.0.2 drop');
  expect(first?.script).toContain('ip daddr @allow0 accept');
  expect(ctx.taps).toEqual(['imp0']);

  const policy = await ctx.egress.readPolicy('dev');

  expect(policy).toEqual({ mode: 'box', allow: ['github.com'] });
});

test('a destroyed imp leaves the table while its row still holds the slot', async () => {
  const rows: (string | undefined)[] = [];
  const holder: { ctx: Awaited<ReturnType<typeof setupEgress>> | null } = { ctx: null };

  await using ctx = await setupEgress(async (script) => {
    if (holder.ctx !== null && !script.includes('chain slot0')) {
      const row = await findImpByName(holder.ctx.db, 'dev');

      rows.push(row?.name);
    }
  });

  holder.ctx = ctx;

  await ctx.imps.createImp({ name: 'dev', policy: { mode: 'none', allow: [] } });
  await ctx.imps.destroyImp('dev');

  expect(rows).toEqual(['dev']);
});

test('a fork has its source policy in its first table', async () => {
  await using ctx = await setupEgress();

  await ctx.imps.createImp({ name: 'dev', policy: { mode: 'none', allow: [] } });

  const app = buildTestApp(ctx, ctx);

  await app.client.imps.fork({ source: 'dev', name: 'copy' });

  const first = ctx.nftScripts.find((script) => script.includes('chain slot1'));

  expect(first).toMatch(
    /chain slot1 \{\n\s+ip saddr != 10\.66\.0\.6 drop\n\s+meta l4proto tcp reject/v,
  );

  const policy = await ctx.egress.readPolicy('copy');

  expect(policy).toEqual({ mode: 'none', allow: [] });
});

test('the resolver admits the list, its aliases and nothing else; granted hosts it answers', async () => {
  await using ctx = await setupEgress();

  await ctx.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['*.npmjs.org'] } });
  await ctx.imps.createImp({ name: 'web' });
  await ctx.imps.createImp({ name: 'shut', policy: { mode: 'none', allow: [] } });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addGrant('dev', 'gh');
  await ctx.broker.addGrant('shut', 'gh');

  const before = [
    await ctx.egress.checkName(0, 'registry.npmjs.org'),
    await ctx.egress.checkName(0, 'api.github.com'),
    await ctx.egress.checkName(0, 'example.org'),
    await ctx.egress.checkName(0, 'npm.cdn.test'),
  ];

  expect(before).toEqual(['admit', 'answer', 'refuse', 'refuse']);

  await ctx.egress.writeAnswers(
    0,
    ['registry.npmjs.org', 'npm.cdn.test'],
    [{ address: '104.16.0.1', ttlS: 300 }],
  );

  expect(ctx.nftScripts.at(-1)).toBe('add element inet imp_egress allow0 { 104.16.0.1 }\n');

  // the alias now; open: not the resolver's; none: only granted hosts; no
  // imp: refused
  const after = [
    await ctx.egress.checkName(0, 'npm.cdn.test'),
    await ctx.egress.checkName(1, 'registry.npmjs.org'),
    await ctx.egress.checkName(2, 'api.github.com'),
    await ctx.egress.checkName(2, 'registry.npmjs.org'),
    await ctx.egress.checkName(9, 'registry.npmjs.org'),
  ];

  expect(after).toEqual(['admit', null, 'answer', 'refuse', null]);
});

test('admitted addresses survive a rebuild, and the sweep deletes them when due', async () => {
  await using ctx = await setupEgress();

  await ctx.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });
  await ctx.egress.writeAnswers(0, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }]);
  await ctx.imps.createImp({ name: 'web' });

  expect(ctx.nftScripts.at(-1)).toContain('elements = { 140.82.112.3 }');

  // 60 s counts as 300 s
  ctx.advance(299_000);

  await ctx.egress.runSweep();

  expect(ctx.nftScripts.at(-1)).toContain('elements = { 140.82.112.3 }');

  ctx.advance(2000);

  await ctx.egress.runSweep();

  expect(ctx.nftScripts.at(-1)).toBe('delete element inet imp_egress allow0 { 140.82.112.3 }\n');
});

test('a tighter policy flushes the guest, prunes the set and refreshes the table', async () => {
  await using ctx = await setupEgress();

  await ctx.imps.createImp({ name: 'dev' });

  expect(ctx.nftScripts.at(-1)).toContain('ip daddr { 169.254.0.0/16, 100.64.0.0/10 } reject');

  await ctx.egress.setPolicy('dev', { mode: 'box', allow: ['github.com', 'npmjs.org'] });
  await ctx.egress.writeAnswers(0, ['github.com'], [{ address: '140.82.112.3', ttlS: 300 }]);
  await ctx.egress.writeAnswers(0, ['npmjs.org'], [{ address: '104.16.0.1', ttlS: 300 }]);
  await ctx.egress.setPolicy('dev', { mode: 'box', allow: ['npmjs.org'] });

  expect(ctx.nftScripts.at(-1)).toContain('elements = { 104.16.0.1 }');
  expect(ctx.nftScripts.at(-1)).not.toContain('140.82.112.3');
  expect(ctx.flushed).toEqual(['10.66.0.2', '10.66.0.2']);

  await ctx.egress.setPolicy('dev', { mode: 'open', allow: [] });

  expect(ctx.flushed).toHaveLength(2);
  expect(ctx.nftScripts.at(-1)).not.toContain('allow0');
});

test('without nft, box and none are refused, and so is a boot of such an imp', async () => {
  const state = { broken: false };

  await using ctx = await setupEgress(() =>
    state.broken ? Promise.reject(new Error('nft is not installed')) : Promise.resolve(),
  );

  await ctx.imps.createImp({ name: 'shut', policy: { mode: 'none', allow: [] } });
  await ctx.imps.stopImp('shut');

  state.broken = true;

  await ctx.egress.start();

  const refused = await readRejection(
    ctx.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: [] } }),
  );

  expect(String(refused)).toContain(
    'cannot enforce a box egress policy here: nft is not installed',
  );

  const boot = await readRejection(ctx.imps.startImp('shut'));

  expect(String(boot)).toContain('cannot enforce a none egress policy');

  // an open imp still runs
  const web = await ctx.imps.createImp({ name: 'web' });

  expect(web.state).toBe('running');
  expect(ctx.logs.some((line) => line.includes('impd: egress: NO FIREWALL'))).toBeTrue();
});
