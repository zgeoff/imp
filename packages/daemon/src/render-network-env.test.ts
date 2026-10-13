import { expect, test } from 'bun:test';
import { loadConfig } from './config';
import { renderNetworkEnv } from './render-network-env';

// host/scripts/setup-net.sh keeps no default of its own: these are the ones it gets
test("it renders impd's defaults for the network setup when nothing sets them", () => {
  expect(renderNetworkEnv(loadConfig({}))).toBe(
    'IMP_SUBNET=10.66.0.0/16\nIMP_BROKER_PORT=7081\nIMP_EGRESS_DNS_PORT=7053\n',
  );
});

test('it renders the subnet and the ports the environment sets', () => {
  const config = loadConfig({
    IMP_SUBNET: '10.70.0.0/16',
    IMP_BROKER_PORT: '7181',
    IMP_EGRESS_DNS_PORT: '7153',
  });

  expect(renderNetworkEnv(config)).toBe(
    'IMP_SUBNET=10.70.0.0/16\nIMP_BROKER_PORT=7181\nIMP_EGRESS_DNS_PORT=7153\n',
  );
});

test('it runs as impd --network-env, from the settings in its environment', () => {
  const result = Bun.spawnSync(
    [process.execPath, new URL('main.ts', import.meta.url).pathname, '--network-env'],
    { env: { PATH: process.env['PATH'] ?? '', IMP_BROKER_PORT: '7181' } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'IMP_SUBNET=10.66.0.0/16\nIMP_BROKER_PORT=7181\nIMP_EGRESS_DNS_PORT=7053\n',
  });
});
