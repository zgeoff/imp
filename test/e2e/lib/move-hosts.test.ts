import { expect, test } from 'bun:test';
import { BlockList } from 'node:net';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { REPO_ROOT, instance } from './instance';
import { buildMoveNetwork, buildMoveSettings, readMoveHosts, readMoveOptions } from './move-hosts';

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
