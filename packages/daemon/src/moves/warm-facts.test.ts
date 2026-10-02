import { expect, test } from 'bun:test';
import type { WarmHost, WarmMove } from '@imp/api';
import { findWarmMismatches } from './warm-facts';

const HOST: WarmHost = {
  firecrackerVersion: 'v1.17.0',
  snapshotVersion: 'v12.0.0',
  hostKernel: '6.8.0',
  cpuModel: 'AMD EPYC 9454P',
  cpuFlags: 'flags-sha',
  dataDir: '/var/lib/imp',
  storage: 'xfs',
  subnet: '10.66.0.0/16',
  slotCount: 16_384,
  brokerPort: 7081,
  dns: ['1.1.1.1', '8.8.8.8'],
};

function buildMove(egressMode: string): WarmMove {
  return {
    slot: 3,
    egressMode,
    snapshot: {
      firecrackerVersion: HOST.firecrackerVersion,
      snapshotVersion: HOST.snapshotVersion,
      hostKernel: HOST.hostKernel,
      cpuModel: HOST.cpuModel,
      cpuFlags: HOST.cpuFlags,
      ipv6Prefix: null,
    },
    host: {
      dataDir: HOST.dataDir,
      storage: HOST.storage,
      subnet: HOST.subnet,
      brokerPort: HOST.brokerPort,
      dns: HOST.dns,
    },
  };
}

test('a host with the same facts takes the memory', () => {
  expect(findWarmMismatches(buildMove('open'), HOST)).toEqual([]);
});

test('IMP_DNS counts for an open imp only: a box imp asks the host resolver', () => {
  const target = { ...HOST, dns: ['9.9.9.9'] };

  expect(findWarmMismatches(buildMove('open'), target)).toEqual([
    'IMP_DNS differs (1.1.1.1,8.8.8.8 here, 9.9.9.9 there)',
  ]);

  expect(findWarmMismatches(buildMove('box'), target)).toEqual([]);
});

test('an imp with IPv6, a snapshot without its CPU, or a slot past the count is refused', () => {
  const move = buildMove('box');

  const found = findWarmMismatches(
    { ...move, slot: 20, snapshot: { ...move.snapshot, cpuModel: null, ipv6Prefix: 'fd00::/64' } },
    { ...HOST, slotCount: 16 },
  );

  expect(found).toEqual([
    'the snapshot does not record its CPU (it is from an older impd)',
    "the imp has an IPv6 address in fd00::/64, this host's prefix",
    "slot 20 is past the target's 16 slots",
  ]);
});

test('an unknown CPU on either side is refused', () => {
  expect(findWarmMismatches(buildMove('box'), { ...HOST, cpuFlags: 'unknown' })).toEqual([
    'a CPU is unknown',
  ]);
});
