import { expect, test } from 'bun:test';
import { BlockList } from 'node:net';
import { buildMoveNetwork } from './move-hosts';

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
])('it gives port offset %d the private network %s', (offset, subnet) => {
  expect(buildMoveNetwork(offset).subnet).toBe(subnet);
});

test('it keeps every move network clear of the imps’ 10.66/16', () => {
  const imps = new BlockList();

  imps.addSubnet('10.66.0.0', 16, 'ipv4');

  const addresses = [0, 1, 64, 100, 255, 256, 1400, 6400, 39_935].map((offset) =>
    buildMoveNetwork(offset).subnet.replace('/24', ''),
  );

  expect(addresses).toSatisfyAll((address: string) => !imps.check(address, 'ipv4'));
});

test('it puts the gateway and both hosts inside the offset’s network', () => {
  expect(buildMoveNetwork(1400)).toStrictEqual({
    subnet: '10.105.120.0/24',
    gateway: '10.105.120.1',
    ipA: '10.105.120.10',
    ipB: '10.105.120.11',
  });
});

test.each([39_936, -1])('it refuses port offset %d, which has no move network', (offset) => {
  expect(() => buildMoveNetwork(offset)).toThrowWithMessage(
    Error,
    `no move network for port offset ${String(offset)}`,
  );
});
