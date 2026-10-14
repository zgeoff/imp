import { expect, test } from 'bun:test';
import { buildBrokerUpstreams, buildSlotGateway } from './broker-upstreams';

test('#buildBrokerUpstreams sends every host to the origin under the CA', () => {
  expect(
    buildBrokerUpstreams('-----BEGIN CERTIFICATE-----', 'https://172.17.0.1:41234', [
      'github.com',
      'api.github.com',
    ]),
  ).toStrictEqual({
    ca: '-----BEGIN CERTIFICATE-----',
    upstreams: {
      'github.com': 'https://172.17.0.1:41234',
      'api.github.com': 'https://172.17.0.1:41234',
    },
  });
});

test.each([
  [1, '10.66.0.5'],
  [63, '10.66.0.253'],
  [64, '10.66.1.1'],
])('#buildSlotGateway gives slot %d the gateway %s', (slot, expected) => {
  expect(buildSlotGateway(slot)).toBe(expected);
});
