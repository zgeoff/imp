import { expect, test } from 'bun:test';
import { findImpByName } from '../db/imps';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { parsePrefix64 } from '../net/addressing6';
import { resolveIpv6Plan } from '../net/ipv6-plan';
import type { Ipv6Plan } from '../net/ipv6-plan';
import { readRejection } from '../read-rejection';

async function setupEgress(runNft?: (script: string) => Promise<void>, ipv6?: Ipv6Plan) {
  const options = {
    ...(runNft !== undefined && { runNft }),
    ...(ipv6 !== undefined && { ipv6 }),
  };

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
    /chain slot1 \{\n\s+ip saddr != 10\.66\.0\.6 drop\n\s+meta nfproto ipv6 drop\n\s+goto deny\n/v,
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

  expect(ctx.nftScripts.at(-1)).toContain('ip daddr { 169.254.0.0/16, 100.64.0.0/10 } goto deny');

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

test('a policy change nft does not take leaves the old policy in place', async () => {
  const state = { broken: false };

  await using ctx = await setupEgress(() =>
    state.broken ? Promise.reject(new Error('nft: table busy')) : Promise.resolve(),
  );

  await ctx.imps.createImp({ name: 'dev' });

  state.broken = true;

  const failed = await readRejection(
    ctx.egress.setPolicy('dev', { mode: 'box', allow: ['github.com'] }),
  );

  const kept = await ctx.egress.readPolicy('dev');

  expect(String(failed)).toContain('nft: table busy');
  expect(kept).toEqual({ mode: 'open', allow: [] });
  expect(ctx.flushed).toEqual([]);

  state.broken = false;

  await ctx.egress.setPolicy('dev', { mode: 'none', allow: [] });

  const changed = await ctx.egress.readPolicy('dev');

  expect(changed).toEqual({ mode: 'none', allow: [] });
});

test('a create during a failing policy change leaves nft and the database agreeing', async () => {
  const applied: string[] = [];
  const held = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const state = { holding: false };

  // nft refuses dev's box set; the first create after dev's waits in nft
  await using ctx = await setupEgress(async (script) => {
    if (script.includes('allow0')) {
      throw new Error('nft: table busy');
    }

    if (!state.holding && script.includes('imp1')) {
      state.holding = true;

      reached.resolve();

      await held.promise;
    }

    applied.push(script);
  });

  await ctx.imps.createImp({ name: 'dev' });

  // a create waits in nft, a second queues behind it, and the policy change
  // comes while both wait
  const first = ctx.imps.createImp({ name: 'first' });

  await reached.promise;

  const second = ctx.imps.createImp({ name: 'second' });

  await Bun.sleep(50);

  const change = readRejection(ctx.egress.setPolicy('dev', { mode: 'box', allow: ['github.com'] }));

  await Bun.sleep(50);

  held.resolve();

  const [failed, ...created] = await Promise.all([change, first, second]);
  const kept = await ctx.egress.readPolicy('dev');

  const tables = applied.filter((script) => script.includes('delete table inet imp_egress'));

  expect(String(failed)).toContain('nft: table busy');
  expect(created.map((imp) => imp.state)).toEqual(['running', 'running']);
  expect(kept).toEqual({ mode: 'open', allow: [] });
  expect(tables.at(-1)).toContain('imp2');
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

test("with IPv6, a slot checks its /128, and the imps' /64 and the container's links are blocked", async () => {
  const prefix = parsePrefix64('fd12:3456:789a::/64');

  if (prefix === null) {
    throw new Error('no prefix');
  }

  await using ctx = await setupEgress(undefined, { prefix, nat66: true, uplink: 'eth0' });

  await ctx.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['2001:db8:c::/48'] } });

  const table = ctx.nftScripts.findLast((script) => script.includes('chain slot0')) ?? '';

  expect(table).toContain('ip6 saddr != fd12:3456:789a::a42:2 drop');
  expect(table).toContain('fd12:3456:789a::/64, 2001:db8:a::/64 }');

  expect(table).toContain(
    'set cidr60 {\n    type ipv6_addr\n    flags interval\n    auto-merge\n    elements = { 2001:db8:c::/48 }',
  );
});

test('a NAT66 that fails turns IPv6 off and leaves the egress table enforced', async () => {
  const scripts: string[] = [];

  const runNft = (script: string): Promise<void> => {
    if (script.includes('masquerade')) {
      return Promise.reject(new Error('Operation not supported'));
    }

    scripts.push(script);

    return Promise.resolve();
  };

  const plan = await resolveIpv6Plan(
    { kind: 'auto' },
    {
      readDefaultRoute: () => Promise.resolve('eth0'),
      readUlaPrefix: () => parsePrefix64('fd12:3456:789a::/64') ?? { network: 0n, text: '' },
      checkHostRules: () => Promise.resolve(null),
      runNft,
      log: () => {},
    },
  );

  expect(plan).toBeNull();

  await using ctx = await setupEgress(runNft);

  await ctx.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });

  const table = scripts.findLast((script) => script.includes('chain slot0')) ?? '';

  expect(ctx.logs.some((line) => line.includes('NO FIREWALL'))).toBeFalse();
  expect(table).toContain('ip saddr != 10.66.0.2 drop');
  expect(table).toContain('meta nfproto ipv6 drop');
});
