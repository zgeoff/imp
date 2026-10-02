import { expect, test } from 'bun:test';
import type { ZfsEntry } from './zfs-commands';
import { planReclaimStep } from './zfs-reclaim';

const RETIRED = 'tank/imp/retired';

function buildFilesystem(name: string, origin: string | null = null): ZfsEntry {
  return { name, type: 'filesystem', origin, deferDestroy: false };
}

function buildSnapshot(name: string, deferDestroy = false): ZfsEntry {
  return { name, type: 'snapshot', origin: null, deferDestroy };
}

test('it destroys a retired dataset that holds no snapshots', () => {
  const entries = [buildFilesystem('tank/imp/disks/a'), buildFilesystem(`${RETIRED}/r`)];

  expect(planReclaimStep(entries, RETIRED)).toEqual({ kind: 'destroy', name: `${RETIRED}/r` });
});

test('it keeps a retired dataset while one of its checkpoints is live', () => {
  const entries = [
    buildFilesystem(`${RETIRED}/r`),
    buildSnapshot(`${RETIRED}/r@cp-old`),
    buildSnapshot(`${RETIRED}/r@cp-new`, true),
    buildFilesystem('tank/imp/disks/a', `${RETIRED}/r@cp-new`),
  ];

  expect(planReclaimStep(entries, RETIRED)).toBeNull();
});

test('it promotes the clone of the newest snapshot once all are marked', () => {
  const entries = [
    buildFilesystem(`${RETIRED}/r`),
    buildSnapshot(`${RETIRED}/r@cp-old`, true),
    buildFilesystem('tank/imp/disks/b', `${RETIRED}/r@cp-old`),
    buildSnapshot(`${RETIRED}/r@fork-1`, true),
    buildFilesystem('tank/imp/disks/c', `${RETIRED}/r@fork-1`),
  ];

  expect(planReclaimStep(entries, RETIRED)).toEqual({
    kind: 'promote',
    name: 'tank/imp/disks/c',
  });
});

test('it destroys a marked snapshot that no clone holds any more', () => {
  const entries = [buildFilesystem(`${RETIRED}/r`), buildSnapshot(`${RETIRED}/r@cp-old`, true)];

  expect(planReclaimStep(entries, RETIRED)).toEqual({
    kind: 'destroy',
    name: `${RETIRED}/r@cp-old`,
  });
});

test('it leaves live disks and images alone', () => {
  const entries = [
    buildFilesystem('tank/imp/images/9f2c'),
    buildSnapshot('tank/imp/images/9f2c@base', true),
    buildFilesystem('tank/imp/disks/a'),
  ];

  expect(planReclaimStep(entries, RETIRED)).toBeNull();
});
