import { expect, test } from 'bun:test';
import { buildMockImpRow } from './build-mock-imp-row';
import { buildInventoryEntry, buildKeptScaleFleet, findAwakeRows } from './restart-inventory';

test('#buildKeptScaleFleet names every imp of scale’s fleet when the harness kept it', () => {
  expect(buildKeptScaleFleet(['e2e-scale-'], 3)).toStrictEqual([
    'e2e-scale-01',
    'e2e-scale-02',
    'e2e-scale-03',
  ]);
});

test('#buildKeptScaleFleet names no imp when the harness kept no fleet', () => {
  expect(buildKeptScaleFleet([], 3)).toStrictEqual([]);
});

test('#buildInventoryEntry keeps what a restart must keep and leaves out state, RAM and activity', () => {
  const row = buildMockImpRow({
    id: 'a1b2c3',
    name: 'e2e-rs-disk',
    image: 'e2e-tiny-202f2b0c',
    state: 'running',
    vcpus: 2,
    memoryMib: 512,
    slot: 4,
    port: 8004,
    ramMib: 61,
  });

  expect(buildInventoryEntry(row, ['cp-b', 'cp-a'])).toStrictEqual({
    name: 'e2e-rs-disk',
    id: 'a1b2c3',
    image: 'e2e-tiny-202f2b0c',
    slot: 4,
    port: 8004,
    vcpus: 2,
    memoryMib: 512,
    checkpoints: ['cp-a', 'cp-b'],
  });
});

test('#findAwakeRows lists every imp that is neither sleeping nor stopped, with its state', () => {
  const rows = [
    buildMockImpRow({ name: 'e2e-rs-disk', state: 'running' }),
    buildMockImpRow({ name: 'e2e-rs-mem', state: 'sleeping' }),
    buildMockImpRow({ name: 'e2e-rs-stopped', state: 'stopped' }),
    buildMockImpRow({ name: 'e2e-rs-new', state: 'creating' }),
    buildMockImpRow({ name: 'e2e-rs-bad', state: 'error' }),
  ];

  expect(findAwakeRows(rows)).toStrictEqual([
    'e2e-rs-disk running',
    'e2e-rs-new creating',
    'e2e-rs-bad error',
  ]);
});
