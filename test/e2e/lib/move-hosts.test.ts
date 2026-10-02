import { expect, test } from 'bun:test';
import { BlockList } from 'node:net';
import { buildMoveNetwork } from './move-hosts';

test('each port offset gets its own private /24, clear of the imps’ 10.66/16', () => {
  const imps = new BlockList();

  imps.addSubnet('10.66.0.0', 16, 'ipv4');

  const subnets = new Set<string>();

  for (const offset of [0, 1, 64, 100, 255, 256, 1400, 6400, 39_935]) {
    const network = buildMoveNetwork(offset);
    const [address = '', prefix = ''] = network.subnet.split('/');

    expect(prefix).toBe('24');
    expect(address).toStartWith('10.');
    expect(imps.check(address, 'ipv4')).toBeFalse();
    expect(network.ipA.slice(0, -3)).toBe(address.slice(0, -2));

    subnets.add(network.subnet);
  }

  expect(subnets.size).toBe(9);

  expect(buildMoveNetwork(1400)).toEqual({
    subnet: '10.105.120.0/24',
    gateway: '10.105.120.1',
    ipA: '10.105.120.10',
    ipB: '10.105.120.11',
  });
});

test('an offset past the band has no move network', () => {
  expect(() => buildMoveNetwork(39_936)).toThrow(/no move network/);
  expect(() => buildMoveNetwork(-1)).toThrow(/no move network/);
});
