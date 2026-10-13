import { expect, test } from 'bun:test';
import { renderNetworkEnv } from './render-network-env';

// host/scripts/setup-net.sh keeps no default of its own: these are the ones it gets
test("it renders impd's defaults for the network setup when nothing sets them", () => {
  expect(renderNetworkEnv({})).toBe(
    'IMP_SUBNET=10.66.0.0/16\nIMP_BROKER_PORT=7081\nIMP_EGRESS_DNS_PORT=7053\n',
  );
});

test('it renders the subnet and the ports the environment sets', () => {
  expect(
    renderNetworkEnv({
      IMP_SUBNET: '10.70.0.0/16',
      IMP_BROKER_PORT: '7181',
      IMP_EGRESS_DNS_PORT: '7153',
    }),
  ).toBe('IMP_SUBNET=10.70.0.0/16\nIMP_BROKER_PORT=7181\nIMP_EGRESS_DNS_PORT=7153\n');
});

test('it reads an empty setting as unset', () => {
  expect(renderNetworkEnv({ IMP_BROKER_PORT: '' })).toBe(
    'IMP_SUBNET=10.66.0.0/16\nIMP_BROKER_PORT=7081\nIMP_EGRESS_DNS_PORT=7053\n',
  );
});

test('it rejects a broker port out of range', () => {
  expect(() => renderNetworkEnv({ IMP_BROKER_PORT: '70000' })).toThrow();
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

// the entrypoint runs it before tailscale-up.sh, so a tailnet setting impd checks against the
// joined tailnet must not stop it
test('it runs as impd --network-env with tailnet names on, before the host joins the tailnet', () => {
  const result = Bun.spawnSync(
    [process.execPath, new URL('main.ts', import.meta.url).pathname, '--network-env'],
    { env: { PATH: process.env['PATH'] ?? '', IMP_TAILNET_NAMES: '1' } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'IMP_SUBNET=10.66.0.0/16\nIMP_BROKER_PORT=7081\nIMP_EGRESS_DNS_PORT=7053\n',
  });
});
