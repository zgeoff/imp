import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { BlockList } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubAnswerQueue } from '@imp/test-utils/build-stub-answer-queue';
import { updateEnv } from '@imp/test-utils/update-env';
import { REPO_ROOT, instance } from './instance';
import type { HostBFixtureDeps } from './move-hosts';
import {
  buildHostBFixture,
  buildMoveNetwork,
  buildMoveSettings,
  readMoveHosts,
  readMoveOptions,
} from './move-hosts';

// a temp dir for the fixture's CLI config, and deps that record each step
// in order
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'move-hosts-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const cliDir = join(dir, 'cli');
  const steps: string[] = [];

  const deps: HostBFixtureDeps = {
    cliDir,
    removeLeftovers: () => {
      steps.push('leftovers');

      return Promise.resolve();
    },
    createNetwork: (name, network) => {
      steps.push(`network ${name} ${network.subnet} ${network.gateway}`);

      return Promise.resolve();
    },
    startHost: (host) => {
      steps.push(`up ${host.container} ${host.env['IMP_DEV_IP'] ?? ''}`);

      return Promise.resolve();
    },
    login: (host, env) => {
      const isStale = existsSync(join(cliDir, 'stale'));

      steps.push(`login ${host.apiUrl} ${env['XDG_CONFIG_HOME'] ?? ''} stale=${String(isStale)}`);

      return Promise.resolve();
    },
    resetHost: (host, prefix) => {
      steps.push(`reset ${host.container} ${prefix}`);

      return Promise.resolve();
    },
    removeHost: (host) => {
      steps.push(`remove ${host.container} ${host.dataDir}`);

      return Promise.resolve();
    },
    log: (line) => {
      steps.push(`log ${line.trim()}`);
    },
  };

  return { cliDir, steps, deps };
}

test.each([
  [0, '10.100.0.0/24'],
  [1, '10.100.1.0/24'],
  [64, '10.100.64.0/24'],
  [100, '10.100.100.0/24'],
  [255, '10.100.255.0/24'],
  [256, '10.101.0.0/24'],
  [1400, '10.105.120.0/24'],
  [6400, '10.125.0.0/24'],
  [39_935, '10.255.255.0/24'],
])('#buildMoveNetwork gives port offset %d the private network %s', (offset, subnet) => {
  expect(buildMoveNetwork(offset).subnet).toBe(subnet);
});

test('#buildMoveNetwork keeps every move network clear of the imps’ 10.66/16', () => {
  const imps = new BlockList();

  imps.addSubnet('10.66.0.0', 16, 'ipv4');

  const addresses = [0, 1, 64, 100, 255, 256, 1400, 6400, 39_935].map((offset) =>
    buildMoveNetwork(offset).subnet.replace('/24', ''),
  );

  expect(addresses).toSatisfyAll((address: string) => !imps.check(address, 'ipv4'));
});

test('#buildMoveNetwork puts the gateway and both hosts inside the offset’s network', () => {
  expect(buildMoveNetwork(1400)).toStrictEqual({
    subnet: '10.105.120.0/24',
    gateway: '10.105.120.1',
    ipA: '10.105.120.10',
    ipB: '10.105.120.11',
  });
});

test.each([39_936, -1])(
  '#buildMoveNetwork refuses port offset %d, which has no move network',
  (offset) => {
    expect(() => buildMoveNetwork(offset)).toThrowWithMessage(
      Error,
      `no move network for port offset ${String(offset)}`,
    );
  },
);

test('#readMoveHosts names B, its network and the CLI config beside the run’s own instance', () => {
  updateEnv('IMP_DEV_PORT_OFFSET', '1400');

  const hosts = readMoveHosts({ tailnet: false });

  expect(hosts.a).toBe(instance);
  expect(hosts.b.container).toBe(`${instance.container}-mv-b`);
  expect(hosts.b.dataDir).toBe(`${instance.dataDir}-mv-b`);
  expect(hosts.b.apiUrl).toBe('http://10.105.120.11:7070');
  expect(hosts.network).toBe(`${instance.container}-mv`);
  expect(hosts.gateway).toBe('10.105.120.1');

  expect(hosts.cliEnv).toStrictEqual({
    XDG_CONFIG_HOME: join(REPO_ROOT, '.cache', 'e2e', `${instance.container}-mv-cli`),
  });
});

test('#readMoveHosts counts A as rebooted onto the network for a move off the tailnet', () => {
  expect(readMoveHosts({ tailnet: false }).isARebooted).toBeTrue();
});

test('#readMoveHosts leaves A as it is for a move over the tailnet', () => {
  expect(readMoveHosts({ tailnet: true }).isARebooted).toBeFalse();
});

test('#buildMoveSettings puts A on the move network with the test range and its peer URL', () => {
  expect(buildMoveSettings({ tailnet: false }, 1400)).toStrictEqual({
    IMP_RAM_BUDGET_MIB: '2048',
    IMP_DEFAULT_MEMORY_MIB: '512',
    IMP_E2E: '1',
    IMP_MOVE_TEST_CIDR: '10.105.120.0/24',
    IMP_PEER_URL: 'http://10.105.120.10:7070',
    IMP_DEV_NETWORK: `${instance.container}-mv`,
    IMP_DEV_IP: '10.105.120.10',
  });
});

test('#buildMoveSettings leaves A on the run’s settings for a move over the tailnet', () => {
  expect(buildMoveSettings({ tailnet: true }, 1400)).toBeNull();
});

test('#buildMoveSettings gives A the settings a move over the tailnet adds, with no test range', () => {
  const settings = buildMoveSettings({ tailnet: true, env: { IMP_TAILNET_NAMES: '1' } }, 1400);

  expect(settings).toStrictEqual({
    IMP_TAILNET_NAMES: '1',
    IMP_RAM_BUDGET_MIB: '2048',
    IMP_DEFAULT_MEMORY_MIB: '512',
    IMP_DEV_NETWORK: `${instance.container}-mv`,
    IMP_DEV_IP: '10.105.120.10',
  });
});

test('#readMoveOptions runs host-b off the tailnet', () => {
  expect(readMoveOptions('host-b')).toStrictEqual({ tailnet: false });
});

test('#readMoveOptions runs host-b-tailnet on the tailnet without per-imp names by default', () => {
  expect(readMoveOptions('host-b-tailnet')).toStrictEqual({ tailnet: true });
});

test('#readMoveOptions runs host-b-tailnet with per-imp names under the test prefix once they are ready', () => {
  updateEnv('IMP_E2E_TAILNET_NAMES', '1');

  expect(readMoveOptions('host-b-tailnet')).toStrictEqual({
    tailnet: true,
    env: { IMP_TAILNET_NAMES: '1', IMP_TAILNET_NAME_PREFIX: 'e2e-' },
  });
});

test('#readMoveHosts counts A as rebooted for a move over the tailnet with settings of its own', () => {
  expect(readMoveHosts({ tailnet: true, env: { IMP_TAILNET_NAMES: '1' } }).isARebooted).toBeTrue();
});

test('#buildHostBFixture starts B on the move network once leftovers are gone, saves it in a fresh CLI config, then resets it', async () => {
  const ctx = await setupTest();

  updateEnv('IMP_DEV_PORT_OFFSET', '1400');

  // a config an earlier run left
  await mkdir(ctx.cliDir);
  await writeFile(join(ctx.cliDir, 'stale'), '');
  await buildHostBFixture({ tailnet: false }, 'e2e-mv-', ctx.deps).start();

  expect(ctx.steps).toStrictEqual([
    'leftovers',
    `network ${instance.container}-mv 10.105.120.0/24 10.105.120.1`,
    `up ${instance.container}-mv-b 10.105.120.11`,
    `login http://10.105.120.11:7070 ${ctx.cliDir} stale=false`,
    `reset ${instance.container}-mv-b e2e-mv-`,
  ]);
});

test('#buildHostBFixture makes B from nothing and resets it again when its reset at start fails', async () => {
  const ctx = await setupTest();

  updateEnv('IMP_DEV_PORT_OFFSET', '1400');

  // the refusal a receiving imp whose source is gone gets
  const resets = buildStubAnswerQueue([
    () => Promise.reject(new Error('e2e-mv-cold is moving')),
    () => Promise.resolve(),
  ]);

  await buildHostBFixture({ tailnet: false }, 'e2e-mv-', {
    ...ctx.deps,
    resetHost: (host, prefix) => {
      ctx.steps.push(`reset ${host.container} ${prefix}`);

      return resets.next()();
    },
  }).start();

  expect(ctx.steps).toStrictEqual([
    'leftovers',
    `network ${instance.container}-mv 10.105.120.0/24 10.105.120.1`,
    `up ${instance.container}-mv-b 10.105.120.11`,
    `login http://10.105.120.11:7070 ${ctx.cliDir} stale=false`,
    `reset ${instance.container}-mv-b e2e-mv-`,
    `log ${instance.container}-mv-b could not be reset, so it starts from nothing: e2e-mv-cold is moving`,
    `remove ${instance.container}-mv-b ${instance.dataDir}-mv-b`,
    `up ${instance.container}-mv-b 10.105.120.11`,
    `login http://10.105.120.11:7070 ${ctx.cliDir} stale=false`,
    `reset ${instance.container}-mv-b e2e-mv-`,
  ]);
});

test('#buildHostBFixture rejects the start when B made from nothing still fails its reset', async () => {
  const ctx = await setupTest();

  const start = buildHostBFixture({ tailnet: false }, 'e2e-mv-', {
    ...ctx.deps,
    resetHost: () => Promise.reject(new Error('impd refused the removal')),
  }).start();

  expect(start).rejects.toThrowWithMessage(Error, 'impd refused the removal');
});

test('#buildHostBFixture resets B for the suite’s prefix', async () => {
  const ctx = await setupTest();

  await buildHostBFixture({ tailnet: false }, 'e2e-mv-', ctx.deps).reset();

  expect(ctx.steps).toStrictEqual([`reset ${instance.container}-mv-b e2e-mv-`]);
});

test('#buildHostBFixture stops B and removes its CLI config', async () => {
  const ctx = await setupTest();

  await mkdir(ctx.cliDir);
  await buildHostBFixture({ tailnet: false }, 'e2e-mv-', ctx.deps).stop();

  expect(ctx.steps).toStrictEqual(['leftovers']);
  expect(existsSync(ctx.cliDir)).toBeFalse();
});
