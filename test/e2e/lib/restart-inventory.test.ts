import { expect, test } from 'bun:test';
import { buildInventoryEntry, findAwakeRows } from './restart-inventory';

test('#buildInventoryEntry keeps what a restart must keep and leaves out state, RAM and activity', () => {
  const row = {
    id: 'a1b2c3',
    name: 'e2e-rs-disk',
    image: 'e2e-tiny-202f2b0c',
    state: 'running' as const,
    vcpus: 2,
    memoryMib: 512,
    slot: 4,
    ip: '10.66.0.18',
    port: 8004,
    url: 'http://e2e-rs-disk.imp.localhost:7080/',
    lastActiveAt: '2026-10-10T05:00:00.000Z',
    ramMib: 61,
  };

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
  const base = {
    id: 'a1b2c3',
    image: 'e2e-tiny-202f2b0c',
    vcpus: 2,
    memoryMib: 512,
    slot: 4,
    ip: '10.66.0.18',
    port: 8004,
    url: 'http://e2e-rs-disk.imp.localhost:7080/',
    lastActiveAt: '2026-10-10T05:00:00.000Z',
  };

  const rows = [
    { ...base, name: 'e2e-rs-disk', state: 'running' as const },
    { ...base, name: 'e2e-rs-mem', state: 'sleeping' as const },
    { ...base, name: 'e2e-rs-stopped', state: 'stopped' as const },
    { ...base, name: 'e2e-rs-new', state: 'creating' as const },
    { ...base, name: 'e2e-rs-bad', state: 'error' as const },
  ];

  expect(findAwakeRows(rows)).toStrictEqual([
    'e2e-rs-disk running',
    'e2e-rs-new creating',
    'e2e-rs-bad error',
  ]);
});
