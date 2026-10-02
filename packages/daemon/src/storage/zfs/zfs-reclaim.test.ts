import { expect, test } from 'bun:test';
import type { ZfsEntry } from './zfs-commands';
import { planReclaimStep } from './zfs-reclaim';

const ROOTS = { retired: 'tank/imp/retired', staging: 'tank/imp/staging' };
const RETIRED = ROOTS.retired;

function buildFilesystem(name: string, origin: string | null = null): ZfsEntry {
  return { name, type: 'filesystem', origin, deferDestroy: false };
}

function buildSnapshot(name: string, deferDestroy = false): ZfsEntry {
  return { name, type: 'snapshot', origin: null, deferDestroy };
}

test('it destroys a retired dataset that holds no snapshots', () => {
  const entries = [buildFilesystem('tank/imp/disks/a'), buildFilesystem(`${RETIRED}/r`)];

  expect(planReclaimStep(entries, ROOTS)).toEqual({ kind: 'destroy', name: `${RETIRED}/r` });
});

test('it keeps a retired dataset while one of its checkpoints is live', () => {
  const entries = [
    buildFilesystem(`${RETIRED}/r`),
    buildSnapshot(`${RETIRED}/r@cp-old`),
    buildSnapshot(`${RETIRED}/r@cp-new`, true),
    buildFilesystem('tank/imp/disks/a', `${RETIRED}/r@cp-new`),
  ];

  expect(planReclaimStep(entries, ROOTS)).toBeNull();
});

test('it promotes the clone of the newest snapshot once all are marked', () => {
  const entries = [
    buildFilesystem(`${RETIRED}/r`),
    buildSnapshot(`${RETIRED}/r@cp-old`, true),
    buildFilesystem('tank/imp/disks/b', `${RETIRED}/r@cp-old`),
    buildSnapshot(`${RETIRED}/r@fork-1`, true),
    buildFilesystem('tank/imp/disks/c', `${RETIRED}/r@fork-1`),
  ];

  expect(planReclaimStep(entries, ROOTS)).toEqual({
    kind: 'promote',
    name: 'tank/imp/disks/c',
  });
});

test('it destroys a marked snapshot that no clone holds any more', () => {
  const entries = [buildFilesystem(`${RETIRED}/r`), buildSnapshot(`${RETIRED}/r@cp-old`, true)];

  expect(planReclaimStep(entries, ROOTS)).toEqual({
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

  expect(planReclaimStep(entries, ROOTS)).toBeNull();
});

test('it waits for a staging clone of the newest snapshot instead of promoting it', () => {
  const entries = [
    buildFilesystem(`${RETIRED}/r`),
    buildSnapshot(`${RETIRED}/r@cp-old`, true),
    buildFilesystem('tank/imp/disks/b', `${RETIRED}/r@cp-old`),
    buildSnapshot(`${RETIRED}/r@bk-run-a`, true),
    buildFilesystem('tank/imp/staging/bk-a', `${RETIRED}/r@bk-run-a`),
  ];

  expect(planReclaimStep(entries, ROOTS)).toBeNull();

  const withFork = [...entries, buildFilesystem('tank/imp/disks/c', `${RETIRED}/r@bk-run-a`)];

  expect(planReclaimStep(withFork, ROOTS)).toEqual({ kind: 'promote', name: 'tank/imp/disks/c' });
});
