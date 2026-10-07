import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { createImage } from '../db/images';
import { findImpByName, updateImpMove } from '../db/imps';
import { removeMember, removeNetwork, writeNetwork } from '../db/networks';
import { openDatabase } from '../db/open-database';
import { parsePrefix64 } from '../net/addressing6';
import { resolveIpv6Plan } from '../net/ipv6-plan';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubNft } from '../test-utils/build-stub-nft';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dataDir = await mkdtemp(join(tmpdir(), 'egress-service-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  // IMP_DEFAULT_IMAGE, which every create here boots from
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const vmm = buildStubVmm();
  const nft = buildStubNft();
  const logs: string[] = [];
  const flushed: string[] = [];
  const flushedPairs: string[] = [];

  // each tap as it came up, with the table nft held then
  const taps: { tap: string; table: string | null }[] = [];

  // a frozen clock that moves only with advance
  const clock = { nowMs: Date.UTC(2026, 0, 1) };

  const deps = {
    db,
    rootToken: 'root-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so a create never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: (message) => {
      logs.push(message);
    },
    now: () => clock.nowMs,
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: buildStubCpuCgroups().cgroups,
    taps: {
      setupTap: (address) => {
        taps.push({ tap: address.tap, table: nft.readTable() });

        return Promise.resolve();
      },
      removeTap: () => Promise.resolve(),
    },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },

    // the host container as setup-net.sh leaves it: its ACCEPT for imps on
    // a network, two links of its own and a default route each way
    egress: {
      runNft: nft.runNft,
      flushConnections: (guestIp) => {
        flushed.push(guestIp);

        return Promise.resolve();
      },
      flushPair: (first, second) => {
        flushedPairs.push(`${first} ${second}`);

        return Promise.resolve();
      },
      readForwardRules: () =>
        Promise.resolve(
          '-A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -m comment --comment imp-network -j ACCEPT\n',
        ),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
      readConnected4: () => Promise.resolve(['172.17.0.0/16', '172.17.0.2/32']),
      readConnected6: () => Promise.resolve(['2001:db8:a::/64']),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: ['eth0'] }),
    },
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  } satisfies ImpdDeps;

  const impds = new AsyncDisposableStack();

  stack.use(impds);

  // impd on this data dir and database; each boot takes its own DNS port,
  // as the resolver binds it on every address
  const startImpd = async (
    overrides: Readonly<{ env?: Readonly<Record<string, string>>; deps?: Partial<ImpdDeps> }> = {},
  ) => {
    // a new disk stays the size of its image: the clone copies every byte
    const config = {
      ...loadConfig({
        IMP_DATA_DIR: dataDir,
        IMP_JAILER: 'false',
        IMP_BOOT_TEMPLATES: 'false',
        IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
        ...overrides.env,
      }),
      defaultDiskBytes: 0,
    };

    const impd = await createImpd(config, {
      ...deps,
      vms: vmm.startGeneration(),
      ...overrides.deps,
    });

    impds.defer(() => impd.broker.stop());

    impds.defer(() => {
      impd.egress.stop();
      impd.diskUsage.stop();
    });

    const link = new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    });

    const client: ContractRouterClient<ImpContract> = createORPCClient(link);

    return { config, impd, client };
  };

  const owned = stack.move();

  return {
    db,
    deps,
    nft,
    logs,
    flushed,
    flushedPairs,
    taps,
    startImpd,
    advance: (ms: number) => {
      clock.nowMs += ms;
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it writes a new imp into the table, with its policy, before its tap comes up', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({
    name: 'dev',
    policy: { mode: 'box', allow: ['github.com'] },
  });

  // the DNS port is a free one, picked per boot
  const tables = ctx.taps.map((tap) =>
    tap.table?.replaceAll(`:${String(booted.config.egressDnsPort)}`, ':<dns port>'),
  );

  expect(tables).toHaveLength(1);

  expect(tables[0]).toMatchInlineSnapshot(`
    "table inet imp_egress {}
    delete table inet imp_egress
    table inet imp_egress {
      set private {
        type ipv4_addr
        flags interval
        auto-merge
        elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 10.66.0.0/16 }
      }
      set blocked6 {
        type ipv6_addr
        flags interval
        auto-merge
        elements = { fc00::/7, fe80::/10, ff00::/8, ::/128, ::1/128, ::/96, ::ffff:0:0/96, ::ffff:0:0:0/96, 100::/64, 100:0:0:1::/64, 64:ff9b::/96, 64:ff9b:1::/48, 2002::/16, 2001::/32, 2001:2::/48, 2001:10::/28, 5f00::/16 }
      }
      set dns_taps {
        type ifname
        elements = { "imp0" }
      }
      set open_peer_taps {
        type ifname
      }
      set allow0 {
        type ipv4_addr
        size 4096
      }
      set cidr0 {
        type ipv4_addr
        flags interval
        auto-merge
      }
      set allow60 {
        type ipv6_addr
        size 4096
      }
      set cidr60 {
        type ipv6_addr
        flags interval
        auto-merge
      }
      chain deny {
        meta l4proto tcp reject with tcp reset
        reject with icmpx admin-prohibited
      }
      chain slot0 {
        ip saddr != 10.66.0.2 drop
        meta nfproto ipv6 drop
        ct state invalid drop
        ct state established,related accept
        ip daddr @cidr0 accept
        ip daddr @private goto deny
        ip daddr @allow0 accept
        ip6 daddr @cidr60 accept
        ip6 daddr @blocked6 goto deny
        ip6 daddr @allow60 accept
        goto deny
      }
      map slots {
        type ifname : verdict
        elements = { "imp0" : jump slot0 }
      }
      chain forward {
        type filter hook forward priority filter - 1; policy accept;
        iifname != "imp*" accept
        oifname "imp*" goto deny
        iifname vmap @slots
        goto deny
      }
      chain input {
        type filter hook input priority filter - 1; policy accept;
        iifname != "imp*" accept
        meta nfproto ipv4 accept
        icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 accept
        drop
      }
      chain dns {
        type nat hook prerouting priority dstnat - 1; policy accept;
        iifname @dns_taps meta nfproto ipv4 ip daddr != 10.66.0.0/16 meta l4proto { tcp, udp } th dport 53 redirect to :<dns port>
        iifname @open_peer_taps ip daddr { 1.1.1.1, 8.8.8.8 } meta l4proto { tcp, udp } th dport 53 redirect to :<dns port>
      }
    }
    "
  `);
});

test('it takes a destroyed imp out of the table while its row still holds the slot', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'none', allow: [] } });

  const held = ctx.nft.hold((script) => script.startsWith('table') && !script.includes('slot0'));
  const destroyed = booted.impd.imps.destroyImp('dev');

  await held.reached;

  const row = await findImpByName(ctx.db, 'dev');

  held.release();

  await destroyed;

  expect(row?.name).toBe('dev');
});

test('it writes a fork into its first table with the policy of its source', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'none', allow: [] } });
  await booted.client.imps.fork({ source: 'dev', name: 'copy' });

  const first = ctx.nft.scripts.find((script) => script.includes('chain slot1'));

  expect(first).toInclude(
    '  chain slot1 {\n    ip saddr != 10.66.0.6 drop\n    meta nfproto ipv6 drop\n    goto deny\n  }\n',
  );
});

test("it gives each slot's verdict on a name by its policy and the broker's grants", async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  const imps = booted.impd.imps;
  const egress = booted.impd.egress;

  await imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['*.npmjs.org'] } });
  await imps.createImp({ name: 'web' });
  await imps.createImp({ name: 'shut', policy: { mode: 'none', allow: [] } });
  await imps.createImp({ name: 'pub', policy: { mode: 'public', allow: [] } });
  await booted.impd.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await booted.impd.broker.addGrant('dev', 'gh');
  await booted.impd.broker.addGrant('shut', 'gh');

  const verdicts = {
    listed: await egress.checkName(0, 'registry.npmjs.org'),
    granted: await egress.checkName(0, 'api.github.com'),
    unlisted: await egress.checkName(0, 'example.org'),
    open: await egress.checkName(1, 'registry.npmjs.org'),
    noneGranted: await egress.checkName(2, 'api.github.com'),
    noneOther: await egress.checkName(2, 'registry.npmjs.org'),
    public: await egress.checkName(3, 'rebind.test'),
    noImp: await egress.checkName(9, 'registry.npmjs.org'),
  };

  expect(verdicts).toStrictEqual({
    listed: 'admit',
    granted: 'answer',
    unlisted: 'refuse',
    open: 'answer',
    noneGranted: 'answer',
    noneOther: 'refuse',
    public: 'screen',
    noImp: null,
  });
});

test("it admits a CNAME target of a box's allowed name as an alias", async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({
    name: 'dev',
    policy: { mode: 'box', allow: ['*.npmjs.org'] },
  });

  await booted.impd.egress.writeAnswers(
    0,
    ['registry.npmjs.org', 'npm.cdn.test'],
    [{ address: '104.16.0.1', ttlS: 300 }],
  );

  const verdict = await booted.impd.egress.checkName(0, 'npm.cdn.test');

  expect(verdict).toBe('admit');
});

test("it adds a box's admitted addresses to its sets, each family to its own", async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });

  await booted.impd.egress.writeAnswers(
    0,
    ['github.com'],
    [
      { address: '140.82.112.3', ttlS: 300 },
      { address: '2606:50c0:8000::153', ttlS: 300 },
    ],
  );

  expect(ctx.nft.scripts.at(-1)).toBe(
    'add element inet imp_egress allow0 { 140.82.112.3 }\nadd element inet imp_egress allow60 { 2606:50c0:8000::153 }\n',
  );
});

test('it writes nothing to nft for the answers of an imp that is not a box', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'web' });

  const before = ctx.nft.scripts.length;

  await booted.impd.egress.writeAnswers(
    0,
    ['github.com'],
    [{ address: '140.82.112.3', ttlS: 300 }],
  );

  expect(ctx.nft.scripts).toHaveLength(before);
});

test('it keeps admitted addresses in a rebuilt table', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });
  await booted.impd.egress.writeAnswers(0, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }]);
  await booted.impd.imps.createImp({ name: 'web' });

  expect(ctx.nft.readTable()).toInclude(
    '  set allow0 {\n    type ipv4_addr\n    size 4096\n    elements = { 140.82.112.3 }\n  }\n',
  );
});

test('it sweeps nothing before an admitted address is due, whatever shorter TTL it came with', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });
  await booted.impd.egress.writeAnswers(0, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }]);

  const before = ctx.nft.scripts.length;

  // 60 s counts as 300 s
  ctx.advance(299_000);

  await booted.impd.egress.runSweep();

  expect(ctx.nft.scripts).toHaveLength(before);
});

test('it sweeps an admitted address out of the set when it is due', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });
  await booted.impd.egress.writeAnswers(0, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }]);

  ctx.advance(300_000);

  await booted.impd.egress.runSweep();

  expect(ctx.nft.scripts.at(-1)).toBe('delete element inet imp_egress allow0 { 140.82.112.3 }\n');
});

test('it lists what a box holds, with names and seconds left, for a warm move', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });

  await booted.impd.egress.writeAnswers(
    0,
    ['github.com'],
    [{ address: '140.82.112.3', ttlS: 600 }],
  );

  ctx.advance(100_000);

  expect(booted.impd.egress.readAnswers(0)).toStrictEqual([
    { names: ['github.com'], address: '140.82.112.3', ttlS: 500 },
  ]);
});

test("it resolves a box's exact names when the box is created, and admits their addresses", async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        resolveExact: () => Promise.resolve([{ address: '140.82.112.3', ttlS: 60 }]),
      },
    },
  });

  await booted.impd.imps.createImp({
    name: 'dev',
    policy: { mode: 'box', allow: ['github.com', '*.npmjs.org'] },
  });

  await waitFor(() => {
    expect(ctx.nft.scripts.at(-1)).toBe('add element inet imp_egress allow0 { 140.82.112.3 }\n');
  });
});

test("it logs an exact name of a box's list that does not resolve", async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        resolveExact: () => Promise.reject(new Error('queryA ESERVFAIL github.com')),
      },
    },
  });

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });

  await waitFor(() => {
    expect(ctx.logs).toContain(
      'impd: egress: dev: resolving github.com: queryA ESERVFAIL github.com',
    );
  });
});

test('it prunes the set of a tighter box to the names it still allows, and flushes the guest', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({
    name: 'dev',
    policy: { mode: 'box', allow: ['github.com', 'npmjs.org'] },
  });

  await booted.impd.egress.writeAnswers(
    0,
    ['github.com'],
    [{ address: '140.82.112.3', ttlS: 300 }],
  );

  await booted.impd.egress.writeAnswers(0, ['npmjs.org'], [{ address: '104.16.0.1', ttlS: 300 }]);
  await booted.impd.egress.setPolicy('dev', { mode: 'box', allow: ['npmjs.org'] });

  expect({ table: ctx.nft.readTable(), flushed: ctx.flushed }).toStrictEqual({
    table: expect.toInclude(
      '  set allow0 {\n    type ipv4_addr\n    size 4096\n    elements = { 104.16.0.1 }\n  }\n',
    ),
    flushed: ['10.66.0.2'],
  });
});

test('it flushes no flows and drops the sets when an imp opens up', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });
  await booted.impd.egress.setPolicy('dev', { mode: 'open', allow: [] });

  expect({ hasSets: ctx.nft.readTable()?.includes('allow0'), flushed: ctx.flushed }).toStrictEqual({
    hasSets: false,
    flushed: [],
  });
});

test('it lets a public imp out only by the uplinks, and refuses it the private ranges, the host and IMP_EGRESS_DENY', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd({
    env: { IMP_EGRESS_DENY: '8.8.4.4,2a01:4f8::7/128', IMP_HOST_ADDRESSES: '2a01:4f8:1::5/64' },
  });

  await booted.impd.imps.createImp({ name: 'dev' });
  await booted.impd.egress.setPolicy('dev', { mode: 'public', allow: [] });

  // the DNS port is a free one, picked per boot
  const table = ctx.nft
    .readTable()
    ?.replaceAll(`:${String(booted.config.egressDnsPort)}`, ':<dns port>');

  expect({ table, flushed: ctx.flushed }).toMatchInlineSnapshot(`
    {
      "flushed": [
        "10.66.0.2",
      ],
      "table": 
    "table inet imp_egress {}
    delete table inet imp_egress
    table inet imp_egress {
      set private {
        type ipv4_addr
        flags interval
        auto-merge
        elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 10.66.0.0/16 }
      }
      set blocked6 {
        type ipv6_addr
        flags interval
        auto-merge
        elements = { fc00::/7, fe80::/10, ff00::/8, ::/128, ::1/128, ::/96, ::ffff:0:0/96, ::ffff:0:0:0/96, 100::/64, 100:0:0:1::/64, 64:ff9b::/96, 64:ff9b:1::/48, 2002::/16, 2001::/32, 2001:2::/48, 2001:10::/28, 5f00::/16 }
      }
      set public4 {
        type ipv4_addr
        flags interval
        auto-merge
        elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 10.66.0.0/16, 172.17.0.0/16, 172.17.0.2/32, 8.8.4.4/32 }
      }
      set public6 {
        type ipv6_addr
        flags interval
        auto-merge
        elements = { fc00::/7, fe80::/10, ff00::/8, ::/128, ::1/128, ::/96, ::ffff:0:0/96, ::ffff:0:0:0/96, 100::/64, 100:0:0:1::/64, 64:ff9b::/96, 64:ff9b:1::/48, 2002::/16, 2001::/32, 2001:2::/48, 2001:10::/28, 5f00::/16, 2001:db8::/32, 3fff::/20, 2001::/31, 2001:2::/32, 2001:4::/40, 2001:4:100::/44, 2001:4:110::/47, 2001:4:113::/48, 2001:4:114::/46, 2001:4:118::/45, 2001:4:120::/43, 2001:4:140::/42, 2001:4:180::/41, 2001:4:200::/39, 2001:4:400::/38, 2001:4:800::/37, 2001:4:1000::/36, 2001:4:2000::/35, 2001:4:4000::/34, 2001:4:8000::/33, 2001:5::/32, 2001:6::/31, 2001:8::/29, 2001:10::/28, 2001:40::/26, 2001:80::/25, 2001:100::/24, 2a01:4f8::7/128, 2a01:4f8:1::/64 }
      }
      set uplinks4 {
        type ifname
        elements = { "eth0" }
      }
      set uplinks6 {
        type ifname
        elements = { "eth0" }
      }
      set dns_taps {
        type ifname
        elements = { "imp0" }
      }
      set open_peer_taps {
        type ifname
      }
      chain deny {
        meta l4proto tcp reject with tcp reset
        reject with icmpx admin-prohibited
      }
      chain slot0 {
        ip saddr != 10.66.0.2 drop
        meta nfproto ipv6 drop
        ct state invalid drop
        meta nfproto ipv4 oifname != @uplinks4 goto deny
        meta nfproto ipv6 oifname != @uplinks6 goto deny
        ip daddr @public4 goto deny
        ip6 daddr @public6 goto deny
        accept
      }
      map slots {
        type ifname : verdict
        elements = { "imp0" : jump slot0 }
      }
      chain forward {
        type filter hook forward priority filter - 1; policy accept;
        iifname != "imp*" accept
        oifname "imp*" goto deny
        iifname vmap @slots
        goto deny
      }
      chain input {
        type filter hook input priority filter - 1; policy accept;
        iifname != "imp*" accept
        meta nfproto ipv4 accept
        icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 accept
        drop
      }
      chain dns {
        type nat hook prerouting priority dstnat - 1; policy accept;
        iifname @dns_taps meta nfproto ipv4 ip daddr != 10.66.0.0/16 meta l4proto { tcp, udp } th dport 53 redirect to :<dns port>
        iifname @open_peer_taps ip daddr { 1.1.1.1, 8.8.8.8 } meta l4proto { tcp, udp } th dport 53 redirect to :<dns port>
      }
    }
    "
    ,
    }
  `);
});

test('it ends every plain tunnel of an imp that becomes public', async () => {
  await using ctx = await setupTest();

  // a far end that holds each connection open and echoes what it reads
  const held = new Set<Socket>();

  const far = createServer((socket) => {
    held.add(socket);
    socket.on('error', () => {});
    socket.pipe(socket);
  });

  const listening = Promise.withResolvers<void>();

  far.listen(0, '127.0.0.1', listening.resolve);

  onTestFinished(() => {
    for (const socket of held) {
      socket.destroy();
    }

    far.close();
  });

  await listening.promise;

  const farAddress = far.address();

  if (typeof farAddress !== 'object' || farAddress === null) {
    throw new Error('the far end has no port');
  }

  const farPort = farAddress.port;

  // guests on loopback, and every tunnel to the far end
  const booted = await ctx.startImpd({
    env: { IMP_SUBNET: '127.0.0.0/16' },
    deps: {
      broker: {
        ...ctx.deps.broker,
        resolveTunnelTarget: () => Promise.resolve('127.0.0.1'),
        dialTunnel: () => createConnection({ host: '127.0.0.1', port: farPort }),
      },
    },
  });

  await booted.impd.imps.createImp({ name: 'dev' });

  const brokerPort = await booted.impd.broker.listen(0);

  const established = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();

  // slot 0's guest is 127.0.0.2
  const tunnel = createConnection(
    { host: '127.0.0.1', port: brokerPort, localAddress: '127.0.0.2' },
    () => {
      tunnel.write('CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n');
    },
  );

  onTestFinished(() => {
    tunnel.destroy();
  });

  tunnel.on('error', () => {});

  tunnel.once('data', () => {
    established.resolve();
  });

  tunnel.once('close', () => {
    closed.resolve();
  });

  await established.promise;

  await booted.impd.egress.setPolicy('dev', { mode: 'public', allow: [] });

  await closed.promise;

  expect(tunnel.destroyed).toBeTrue();
});

test('it keeps the plain tunnels of an imp that stays public', async () => {
  await using ctx = await setupTest();

  // a far end that holds each connection open and echoes what it reads
  const held = new Set<Socket>();

  const far = createServer((socket) => {
    held.add(socket);
    socket.on('error', () => {});
    socket.pipe(socket);
  });

  const listening = Promise.withResolvers<void>();

  far.listen(0, '127.0.0.1', listening.resolve);

  onTestFinished(() => {
    for (const socket of held) {
      socket.destroy();
    }

    far.close();
  });

  await listening.promise;

  const farAddress = far.address();

  if (typeof farAddress !== 'object' || farAddress === null) {
    throw new Error('the far end has no port');
  }

  const farPort = farAddress.port;

  // guests on loopback, and every tunnel to the far end
  const booted = await ctx.startImpd({
    env: { IMP_SUBNET: '127.0.0.0/16' },
    deps: {
      broker: {
        ...ctx.deps.broker,
        resolveTunnelTarget: () => Promise.resolve('127.0.0.1'),
        dialTunnel: () => createConnection({ host: '127.0.0.1', port: farPort }),
      },
    },
  });

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'public', allow: [] } });

  const brokerPort = await booted.impd.broker.listen(0);

  const established = Promise.withResolvers<void>();
  const echoed = Promise.withResolvers<string>();

  // slot 0's guest is 127.0.0.2
  const tunnel = createConnection(
    { host: '127.0.0.1', port: brokerPort, localAddress: '127.0.0.2' },
    () => {
      tunnel.write('CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n');
    },
  );

  onTestFinished(() => {
    tunnel.destroy();
  });

  tunnel.on('error', () => {});

  tunnel.once('data', () => {
    established.resolve();

    tunnel.once('data', (chunk: Buffer) => {
      echoed.resolve(chunk.toString());
    });
  });

  await established.promise;

  await booted.impd.egress.setPolicy('dev', { mode: 'public', allow: [] });

  tunnel.write('still here');

  const echo = await echoed.promise;

  expect(echo).toBe('still here');
});

test('it refuses a public policy whose routes cannot be read, and leaves the imp as it was', async () => {
  await using ctx = await setupTest();

  const routes = { fail: false };

  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        readUplinks: () =>
          routes.fail
            ? Promise.reject(new Error('ip -4 route show default exited 1'))
            : Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
      },
    },
  });

  await booted.impd.imps.createImp({ name: 'dev' });
  await booted.impd.imps.createImp({ name: 'pub', policy: { mode: 'public', allow: [] } });

  routes.fail = true;

  const change = booted.impd.egress.setPolicy('dev', { mode: 'public', allow: [] });

  expect(change).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message:
      'impd cannot read the routes a public egress policy needs: ip -4 route show default exited 1',
  });

  expect(booted.impd.egress.readPolicy('dev')).resolves.toStrictEqual({ mode: 'open', allow: [] });
});

test('it leaves a running public imp no uplink while the routes cannot be read', async () => {
  await using ctx = await setupTest();

  const routes = { fail: false };

  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        readUplinks: () =>
          routes.fail
            ? Promise.reject(new Error('ip -4 route show default exited 1'))
            : Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
      },
    },
  });

  await booted.impd.imps.createImp({ name: 'pub', policy: { mode: 'public', allow: [] } });

  routes.fail = true;

  await booted.impd.imps.createImp({ name: 'dev' });

  expect(ctx.nft.readTable()).toInclude('  set uplinks4 {\n    type ifname\n  }\n');

  expect(ctx.logs).toContain(
    "impd: egress: reading the host container's routes: ip -4 route show default exited 1",
  );
});

test('it refuses a public policy outright while the routes cannot be read', async () => {
  await using ctx = await setupTest();

  const routes = { fail: false };

  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        readUplinks: () =>
          routes.fail
            ? Promise.reject(new Error('ip -4 route show default exited 1'))
            : Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
      },
    },
  });

  await booted.impd.imps.createImp({ name: 'pub', policy: { mode: 'public', allow: [] } });

  routes.fail = true;

  await booted.impd.imps.createImp({ name: 'dev' });

  expect(() => {
    booted.impd.egress.requirePolicy({ mode: 'public', allow: [] });
  }).toThrowWithMessage(
    Error,
    'impd cannot read the routes a public egress policy needs: ip -4 route show default exited 1',
  );
});

test('it builds the table again for a public imp once the routes are back', async () => {
  await using ctx = await setupTest();

  const routes = { fail: false };

  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        readUplinks: () =>
          routes.fail
            ? Promise.reject(new Error('ip -4 route show default exited 1'))
            : Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
      },
    },
  });

  await booted.impd.imps.createImp({ name: 'pub', policy: { mode: 'public', allow: [] } });
  await booted.impd.imps.stopImp('pub');

  routes.fail = true;

  await booted.impd.imps.createImp({ name: 'dev' });

  routes.fail = false;

  const pub = await findImpByName(ctx.db, 'pub');

  invariant(pub);

  await booted.impd.egress.requireImp(pub.id);

  expect(ctx.nft.readTable()).toInclude(
    '  set uplinks4 {\n    type ifname\n    elements = { "eth0" }\n  }\n',
  );
});

test('it warns once that a public imp lacks the host addresses when IMP_HOST_ADDRESSES is empty', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'a', policy: { mode: 'public', allow: [] } });
  await booted.impd.imps.createImp({ name: 'b', policy: { mode: 'public', allow: [] } });

  expect(ctx.logs.filter((line) => line.includes('IMP_HOST_ADDRESSES is empty'))).toHaveLength(1);
});

test('it warns that a public imp lacks the host addresses even when IMP_EGRESS_DENY holds some', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd({ env: { IMP_EGRESS_DENY: '203.0.113.7' } });

  await booted.impd.imps.createImp({ name: 'a', policy: { mode: 'public', allow: [] } });

  expect(ctx.logs.filter((line) => line.includes('IMP_HOST_ADDRESSES is empty'))).toHaveLength(1);
});

test('it gives no warning for a public imp when IMP_HOST_ADDRESSES is set', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd({ env: { IMP_HOST_ADDRESSES: '203.0.113.9/24' } });

  await booted.impd.imps.createImp({ name: 'a', policy: { mode: 'public', allow: [] } });

  expect(ctx.logs.filter((line) => line.includes('IMP_HOST_ADDRESSES is empty'))).toBeEmpty();
});

test('it leaves the old policy in place, and flushes nothing, when nft refuses a change', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev' });

  ctx.nft.refuse({ reason: 'table busy', match: (script) => script.includes('allow0') });

  const change = booted.impd.egress.setPolicy('dev', { mode: 'box', allow: ['github.com'] });

  expect(change).rejects.toThrow(new Error('nft exited 1: table busy'));

  expect({
    policy: await booted.impd.egress.readPolicy('dev'),
    table: ctx.nft.readTable(),
    flushed: ctx.flushed,
  }).toStrictEqual({
    policy: { mode: 'open', allow: [] },
    table: expect.toInclude(
      '  chain slot0 {\n    ip saddr != 10.66.0.2 drop\n    meta nfproto ipv6 drop\n    ip daddr { 169.254.0.0/16, 100.64.0.0/10 } goto deny\n',
    ),
    flushed: [],
  });
});

test('it leaves nft and the database agreeing when a create meets a failing policy change', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev' });

  // nft refuses dev's box set; the first create after dev's waits in nft
  ctx.nft.refuse({ reason: 'table busy', match: (script) => script.includes('allow0') });

  const held = ctx.nft.hold((script) => script.includes('imp1'));
  const first = booted.impd.imps.createImp({ name: 'first' });

  await held.reached;

  // a second create gets its row, then waits behind the first for the table
  const second = booted.impd.imps.createImp({ name: 'second' });

  await waitFor(async () => {
    const row = await findImpByName(ctx.db, 'second');

    expect(row).toBeDefined();
  });

  const change = booted.impd.egress.setPolicy('dev', { mode: 'box', allow: ['github.com'] });

  held.release();

  const results = await Promise.allSettled([change, first, second]);

  expect({
    results: results.map((result) => result.status),
    policy: await booted.impd.egress.readPolicy('dev'),
    table: ctx.nft.readTable(),
  }).toStrictEqual({
    results: ['rejected', 'fulfilled', 'fulfilled'],
    policy: { mode: 'open', allow: [] },
    table: expect.toSatisfy(
      (table: string) => table.includes('chain slot2') && !table.includes('allow0'),
    ),
  });
});

test('it refuses a box without nft', async () => {
  await using ctx = await setupTest();

  ctx.nft.refuse({ reason: 'nft is not installed' });

  const booted = await ctx.startImpd();

  const create = booted.impd.imps.createImp({
    name: 'dev',
    policy: { mode: 'box', allow: [] },
  });

  expect(create).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'impd cannot enforce a box egress policy here: nft exited 1: nft is not installed',
  });
});

test('it refuses to boot an imp whose policy is none without nft', async () => {
  await using ctx = await setupTest();

  const first = await ctx.startImpd();

  await first.impd.imps.createImp({ name: 'shut', policy: { mode: 'none', allow: [] } });
  await first.impd.imps.stopImp('shut');

  ctx.nft.refuse({ reason: 'nft is not installed' });

  const restarted = await ctx.startImpd();

  expect(restarted.impd.imps.startImp('shut')).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'impd cannot enforce a none egress policy here: nft exited 1: nft is not installed',
  });
});

test('it runs an open imp without nft, and says the firewall is off', async () => {
  await using ctx = await setupTest();

  ctx.nft.refuse({ reason: 'nft is not installed' });

  const booted = await ctx.startImpd();
  const web = await booted.impd.imps.createImp({ name: 'web' });

  expect({ state: web.state, enforced: booted.impd.egress.isEnforced() }).toStrictEqual({
    state: 'running',
    enforced: false,
  });

  expect(ctx.logs).toContain(
    'impd: egress: NO FIREWALL: nft exited 1: nft is not installed; imps with a public, box or none policy will not start (0 now)',
  );
});

test("it says nft is not installed when impd cannot start nft's binary", async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        runNft: () =>
          Promise.reject(
            Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'nft'"), {
              code: 'ENOENT',
            }),
          ),
      },
    },
  });

  expect(() => {
    booted.impd.egress.requirePolicy({ mode: 'none', allow: [] });
  }).toThrowWithMessage(
    Error,
    'impd cannot enforce a none egress policy here: nft is not installed',
  );
});

test("it checks an IPv6 slot's source /128, and blocks the imps' /64 and the container's links", async () => {
  await using ctx = await setupTest();

  const prefix = parsePrefix64('fd12:3456:789a::/64');

  invariant(prefix);

  const booted = await ctx.startImpd({
    deps: { resolveIpv6: () => Promise.resolve({ prefix, nat66: true, uplink: 'eth0' }) },
  });

  await booted.impd.imps.createImp({
    name: 'dev',
    policy: { mode: 'box', allow: ['2001:db8:c::/48'] },
  });

  // the DNS port is a free one, picked per boot
  const table = ctx.nft
    .readTable()
    ?.replaceAll(`:${String(booted.config.egressDnsPort)}`, ':<dns port>');

  expect(table).toMatchInlineSnapshot(`
    "table inet imp_egress {}
    delete table inet imp_egress
    table inet imp_egress {
      set private {
        type ipv4_addr
        flags interval
        auto-merge
        elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 10.66.0.0/16 }
      }
      set blocked6 {
        type ipv6_addr
        flags interval
        auto-merge
        elements = { fc00::/7, fe80::/10, ff00::/8, ::/128, ::1/128, ::/96, ::ffff:0:0/96, ::ffff:0:0:0/96, 100::/64, 100:0:0:1::/64, 64:ff9b::/96, 64:ff9b:1::/48, 2002::/16, 2001::/32, 2001:2::/48, 2001:10::/28, 5f00::/16, fd12:3456:789a::/64, 2001:db8:a::/64 }
      }
      set dns_taps {
        type ifname
        elements = { "imp0" }
      }
      set open_peer_taps {
        type ifname
      }
      set allow0 {
        type ipv4_addr
        size 4096
      }
      set cidr0 {
        type ipv4_addr
        flags interval
        auto-merge
      }
      set allow60 {
        type ipv6_addr
        size 4096
      }
      set cidr60 {
        type ipv6_addr
        flags interval
        auto-merge
        elements = { 2001:db8:c::/48 }
      }
      chain deny {
        meta l4proto tcp reject with tcp reset
        reject with icmpx admin-prohibited
      }
      chain slot0 {
        ip saddr != 10.66.0.2 drop
        ip6 saddr != fd12:3456:789a::a42:2 drop
        ct state invalid drop
        ct state established,related accept
        ip daddr @cidr0 accept
        ip daddr @private goto deny
        ip daddr @allow0 accept
        ip6 daddr @cidr60 accept
        ip6 daddr @blocked6 goto deny
        ip6 daddr @allow60 accept
        goto deny
      }
      map slots {
        type ifname : verdict
        elements = { "imp0" : jump slot0 }
      }
      chain forward {
        type filter hook forward priority filter - 1; policy accept;
        iifname != "imp*" accept
        oifname "imp*" goto deny
        iifname vmap @slots
        goto deny
      }
      chain input {
        type filter hook input priority filter - 1; policy accept;
        iifname != "imp*" accept
        meta nfproto ipv4 accept
        icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 accept
        drop
      }
      chain dns {
        type nat hook prerouting priority dstnat - 1; policy accept;
        iifname @dns_taps meta nfproto ipv4 ip daddr != 10.66.0.0/16 meta l4proto { tcp, udp } th dport 53 redirect to :<dns port>
        iifname @open_peer_taps ip daddr { 1.1.1.1, 8.8.8.8 } meta l4proto { tcp, udp } th dport 53 redirect to :<dns port>
      }
    }
    "
  `);
});

test('it turns IPv6 off when NAT66 fails, and still enforces the egress table', async () => {
  await using ctx = await setupTest();

  ctx.nft.refuse({
    reason: 'Operation not supported',
    match: (script) => script.includes('masquerade'),
  });

  const booted = await ctx.startImpd({
    deps: {
      resolveIpv6: () =>
        resolveIpv6Plan(
          { kind: 'auto' },
          {
            readDefaultRoute: () => Promise.resolve('eth0'),
            readUlaPrefix: () => parsePrefix64('fd12:3456:789a::/64') ?? { network: 0n, text: '' },
            checkHostRules: () => Promise.resolve(null),
            runNft: ctx.nft.runNft,
            log: () => {},
          },
        ),
    },
  });

  await booted.impd.imps.createImp({ name: 'dev', policy: { mode: 'box', allow: ['github.com'] } });

  expect({ enforced: booted.impd.egress.isEnforced(), table: ctx.nft.readTable() }).toStrictEqual({
    enforced: true,
    table: expect.toInclude(
      '  chain slot0 {\n    ip saddr != 10.66.0.2 drop\n    meta nfproto ipv6 drop\n',
    ),
  });
});

test('it builds the table from the rows when nft refuses a network change and the undo throws', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();
  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  await booted.impd.imps.createImp({ name: 'web', networkIds: [network.id] });
  await booted.impd.imps.createImp({ name: 'db', networkIds: [network.id] });

  ctx.nft.refuse({ reason: 'table busy', times: 1 });

  const change = booted.impd.egress.changeNetworks({
    write: () => removeNetwork(ctx.db, network.id),
    undo: () => Promise.reject(new Error('the database is gone')),
  });

  expect(change).rejects.toThrow(
    new Error(
      'nft exited 1: table busy; the network change could not be undone and may have applied',
    ),
  );

  const table = ctx.nft.readTable();

  invariant(table);

  expect(table).not.toInclude('@net0');

  expect(ctx.logs).toIncludeAllMembers([
    'impd: egress: undoing a network change (try 1): the database is gone',
    'impd: egress: undoing a network change (try 2): the database is gone',
  ]);
});

test('it rethrows the refusal of nft, and keeps the network, when the undo of a change succeeds', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();
  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  await booted.impd.imps.createImp({ name: 'web', networkIds: [network.id] });
  await booted.impd.imps.createImp({ name: 'db', networkIds: [network.id] });

  const dbImp = await findImpByName(ctx.db, 'db');

  invariant(dbImp);

  ctx.nft.refuse({ reason: 'table busy', times: 1 });

  const change = booted.impd.egress.changeNetworks({
    write: () => removeMember(ctx.db, network.id, dbImp.id),
    undo: async () => {
      await ctx.db
        .insertInto('network_members')
        .values({ network_id: network.id, imp_id: dbImp.id })
        .execute();
    },
  });

  expect(change).rejects.toThrow(new Error('nft exited 1: table busy'));

  expect(ctx.nft.readTable()).toInclude(
    '  set net0 {\n    type ifname . ipv4_addr\n    elements = { "imp1" . 10.66.0.6, "imp0" . 10.66.0.2 }\n  }\n',
  );
});

test('it drops the flows of a pair that a change parts', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();
  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  await booted.impd.imps.createImp({ name: 'web', networkIds: [network.id] });
  await booted.impd.imps.createImp({ name: 'db', networkIds: [network.id] });

  await booted.impd.egress.changeNetworks({
    write: () => removeNetwork(ctx.db, network.id),
    undo: () => Promise.resolve(),
  });

  expect(ctx.flushedPairs).toStrictEqual(['10.66.0.2 10.66.0.6']);
});

test('it logs a pair whose flows cannot be dropped, and keeps the change', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        flushPair: () =>
          Promise.reject(new Error('conntrack -D exited 1: Operation not permitted')),
      },
    },
  });

  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  await booted.impd.imps.createImp({ name: 'web', networkIds: [network.id] });
  await booted.impd.imps.createImp({ name: 'db', networkIds: [network.id] });

  const result = await booted.impd.egress.changeNetworks({
    write: () => removeNetwork(ctx.db, network.id).then(() => 'removed'),
    undo: () => Promise.resolve(),
  });

  expect(result).toBe('removed');

  expect(ctx.logs).toContain(
    'impd: egress: 10.66.0.2 10.66.0.6: conntrack -D exited 1: Operation not permitted',
  );
});

test("it says once that setup-net.sh's imp-network ACCEPT is missing from a table with members", async () => {
  await using ctx = await setupTest();

  // the rule without its mark, as a hand-made one might be
  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        readForwardRules: () =>
          Promise.resolve('-A FORWARD -m comment --comment imp-network -j ACCEPT\n'),
      },
    },
  });

  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  await booted.impd.imps.createImp({ name: 'web', networkIds: [network.id] });
  await booted.impd.imps.createImp({ name: 'db', networkIds: [network.id] });

  expect(ctx.logs.filter((line) => line.includes('imp-network ACCEPT is missing'))).toHaveLength(1);
});

test('it logs a FORWARD chain it cannot read', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd({
    deps: {
      egress: {
        ...ctx.deps.egress,
        readForwardRules: () =>
          Promise.reject(new Error('iptables -S FORWARD exited 4: Permission denied')),
      },
    },
  });

  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  await booted.impd.imps.createImp({ name: 'web', networkIds: [network.id] });

  expect(ctx.logs).toContain(
    'impd: egress: reading FORWARD: iptables -S FORWARD exited 4: Permission denied',
  );
});

test('it rejects a policy read of an imp that does not exist as NOT_FOUND', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  expect(booted.impd.egress.readPolicy('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it rejects a policy change of an imp that does not exist as NOT_FOUND', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  expect(booted.impd.egress.setPolicy('ghost', { mode: 'none', allow: [] })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('it rejects a policy change of an imp on the move as MOVING', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();
  const imp = await booted.impd.imps.createImp({ name: 'dev' });

  await updateImpMove(ctx.db, imp.id, 'sending');

  expect(booted.impd.egress.setPolicy('dev', { mode: 'none', allow: [] })).rejects.toMatchObject({
    code: 'MOVING',
  });
});

test('it frees the DNS port when it stops', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  booted.impd.egress.stop();

  const socket = await Bun.udpSocket({ port: booted.config.egressDnsPort });

  onTestFinished(() => {
    socket.close();
  });

  expect(socket.port).toBe(booted.config.egressDnsPort);
});

test('it logs a rebuild of the table that nft refuses too after a failed change', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.startImpd();

  await booted.impd.imps.createImp({ name: 'dev' });

  ctx.nft.refuse({ reason: 'table busy', times: 2 });

  const change = booted.impd.egress.setPolicy('dev', { mode: 'none', allow: [] });

  expect(change).rejects.toThrow(new Error('nft exited 1: table busy'));
  expect(ctx.logs).toContain('impd: egress: rebuilding the table: nft exited 1: table busy');
});
