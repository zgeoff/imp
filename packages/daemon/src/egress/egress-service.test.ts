import { expect, test } from 'bun:test';
import { findImpByName } from '../db/imps';
import { removeNetwork, writeNetwork } from '../db/networks';
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

  // the alias now; open: forwarded as it is; none: only granted hosts; no
  // imp: refused
  const after = [
    await ctx.egress.checkName(0, 'npm.cdn.test'),
    await ctx.egress.checkName(1, 'registry.npmjs.org'),
    await ctx.egress.checkName(2, 'api.github.com'),
    await ctx.egress.checkName(2, 'registry.npmjs.org'),
    await ctx.egress.checkName(9, 'registry.npmjs.org'),
  ];

  expect(after).toEqual(['admit', 'answer', 'answer', 'refuse', null]);
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

test('a public imp leaves only by the uplinks, and is refused the private ranges, the host and IMP_EGRESS_DENY', async () => {
  await using ctx = await setupImpTest({
    env: { IMP_EGRESS_DENY: '8.8.4.4,2a01:4f8::7/128' },
  });

  await ctx.createTestImage('base');
  await ctx.imps.createImp({ name: 'dev' });

  // open, then public: tighter, so the guest's flows go
  await ctx.egress.setPolicy('dev', { mode: 'public', allow: [] });

  const table = ctx.nftScripts.at(-1) ?? '';

  expect(table).toContain(
    '    oifname != @uplinks goto deny\n    ip daddr @public4 goto deny\n    ip6 daddr @public6 goto deny\n    accept\n',
  );

  expect(table).toContain('set uplinks {\n    type ifname\n    elements = { "eth0" }');

  // the private ranges, IMP_SUBNET, the host's networks and IMP_EGRESS_DENY
  expect(table).toMatch(
    /set public4 \{[^\}]*elements = \{ 0\.0\.0\.0\/8, [^\}]*10\.66\.0\.0\/16, 172\.17\.0\.0\/16, 172\.17\.0\.2\/32, 44\.0\.0\.0\/24, 8\.8\.4\.4\/32 \}/v,
  );

  expect(table).toMatch(/set public6 \{[^\}]*2001:db8::\/32, 3fff::\/20, 2a01:4f8::7\/128 \}/v);
  expect(table).toMatch(/set dns_taps \{\n {4}type ifname\n {4}elements = \{ "imp0" \}/v);
  expect(ctx.flushed).toEqual(['10.66.0.2']);

  // any name, screened
  const verdicts = [
    await ctx.egress.checkName(0, 'example.com'),
    await ctx.egress.checkName(0, 'rebind.test'),
  ];

  expect(verdicts).toEqual(['screen', 'screen']);
});

test('a change to public ends every plain tunnel, and one that stays public keeps them', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('base');
  await ctx.imps.createImp({ name: 'dev' });

  const kept: boolean[] = [];

  const readKeep = (): void => {
    const keep = ctx.closedTunnels.at(-1)?.keep;

    kept.push(keep?.('example.org') ?? true);
  };

  await ctx.egress.setPolicy('dev', { mode: 'public', allow: [] });

  readKeep();

  await ctx.egress.setPolicy('dev', { mode: 'public', allow: [] });

  readKeep();

  expect(kept).toEqual([false, true]);
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

  expect(ctx.egress.isEnforced()).toBeTrue();

  state.broken = true;

  await ctx.egress.start();

  expect(ctx.egress.isEnforced()).toBeFalse();

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

test('a network change that nft refuses and whose undo throws still leaves the table from the rows', async () => {
  const state = { refuse: false };
  const scripts: string[] = [];

  await using ctx = await setupEgress((script) => {
    if (state.refuse) {
      state.refuse = false;

      return Promise.reject(new Error('nft exited 1'));
    }

    scripts.push(script);

    return Promise.resolve();
  });

  const network = await writeNetwork(ctx.db, 'lab');

  await ctx.imps.createImp({ name: 'web', networkIds: network === null ? [] : [network.id] });
  await ctx.imps.createImp({ name: 'db', networkIds: network === null ? [] : [network.id] });

  const joined = scripts.at(-1);

  state.refuse = true;

  const error = await readRejection(
    ctx.egress.changeNetworks({
      write: () => removeNetwork(ctx.db, network?.id ?? ''),
      undo: () => Promise.reject(new Error('the database is gone')),
    }),
  );

  expect(String(error)).toContain('nft exited 1');
  expect(joined).toContain('@net0');
  expect(scripts.at(-1)).not.toContain('@net0');
  expect(ctx.logs.join('\n')).toContain('the database is gone');
});

test("a table with members and without setup-net's imp-network ACCEPT says so, once", async () => {
  await using ctx = await setupImpTest({
    // the rule without its mark, as a hand-made one might be
    forwardRules: '-A FORWARD -m comment --comment imp-network -j ACCEPT\n',
  });

  await ctx.createTestImage('base');

  const network = await writeNetwork(ctx.db, 'lab');

  const networkIds = network === null ? [] : [network.id];

  await ctx.imps.createImp({ name: 'web', networkIds });
  await ctx.imps.createImp({ name: 'db', networkIds });

  const missing = ctx.logs.filter((line) => line.includes('imp-network ACCEPT is missing'));

  expect(missing).toHaveLength(1);
});

test('a join whose table nft refuses and whose undo throws twice says it may have applied', async () => {
  const state = { refuse: false };

  await using ctx = await setupEgress(() => {
    const result = state.refuse ? Promise.reject(new Error('nft exited 1')) : Promise.resolve();

    return result;
  });

  const undos: string[] = [];

  state.refuse = true;

  const error = await readRejection(
    ctx.egress.changeNetworks({
      write: () => Promise.resolve(),
      undo: () => {
        undos.push('undo');

        return Promise.reject(new Error('the database is gone'));
      },
    }),
  );

  expect(undos).toEqual(['undo', 'undo']);

  expect(String(error)).toContain(
    'nft exited 1; the network change could not be undone and may have applied',
  );
});
