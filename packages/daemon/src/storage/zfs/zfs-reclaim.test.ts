import { expect, test } from 'bun:test';
import { buildMockZfsEntry } from '../../test-utils/build-mock-zfs-entry';
import { planReclaimStep } from './zfs-reclaim';

test('it destroys a retired dataset that holds no snapshots', () => {
  const entries = [
    buildMockZfsEntry({ name: 'tank/imp/disks/a' }),
    buildMockZfsEntry({ name: 'tank/imp/retired/r' }),
  ];

  expect(
    planReclaimStep(entries, { retired: 'tank/imp/retired', staging: 'tank/imp/staging' }),
  ).toStrictEqual({ kind: 'destroy', name: 'tank/imp/retired/r' });
});

test('it keeps a retired dataset while one of its checkpoints is live', () => {
  const entries = [
    buildMockZfsEntry({ name: 'tank/imp/retired/r' }),
    buildMockZfsEntry({ name: 'tank/imp/retired/r@cp-old', type: 'snapshot' }),
    buildMockZfsEntry({ name: 'tank/imp/retired/r@cp-new', type: 'snapshot', deferDestroy: true }),
    buildMockZfsEntry({ name: 'tank/imp/disks/a', origin: 'tank/imp/retired/r@cp-new' }),
  ];

  expect(
    planReclaimStep(entries, { retired: 'tank/imp/retired', staging: 'tank/imp/staging' }),
  ).toBeNull();
});

test('it promotes the clone of the newest snapshot once all are marked', () => {
  const entries = [
    buildMockZfsEntry({ name: 'tank/imp/retired/r' }),
    buildMockZfsEntry({ name: 'tank/imp/retired/r@cp-old', type: 'snapshot', deferDestroy: true }),
    buildMockZfsEntry({ name: 'tank/imp/disks/b', origin: 'tank/imp/retired/r@cp-old' }),
    buildMockZfsEntry({ name: 'tank/imp/retired/r@fork-1', type: 'snapshot', deferDestroy: true }),
    buildMockZfsEntry({ name: 'tank/imp/disks/c', origin: 'tank/imp/retired/r@fork-1' }),
  ];

  expect(
    planReclaimStep(entries, { retired: 'tank/imp/retired', staging: 'tank/imp/staging' }),
  ).toStrictEqual({ kind: 'promote', name: 'tank/imp/disks/c' });
});

test('it destroys a marked snapshot that no clone holds any more', () => {
  const entries = [
    buildMockZfsEntry({ name: 'tank/imp/retired/r' }),
    buildMockZfsEntry({ name: 'tank/imp/retired/r@cp-old', type: 'snapshot', deferDestroy: true }),
  ];

  expect(
    planReclaimStep(entries, { retired: 'tank/imp/retired', staging: 'tank/imp/staging' }),
  ).toStrictEqual({ kind: 'destroy', name: 'tank/imp/retired/r@cp-old' });
});

test('it never touches a live disk or image', () => {
  const entries = [
    buildMockZfsEntry({ name: 'tank/imp/images/9f2c' }),
    buildMockZfsEntry({ name: 'tank/imp/images/9f2c@base', type: 'snapshot', deferDestroy: true }),
    buildMockZfsEntry({ name: 'tank/imp/disks/a' }),
  ];

  expect(
    planReclaimStep(entries, { retired: 'tank/imp/retired', staging: 'tank/imp/staging' }),
  ).toBeNull();
});

test('it waits for a staging clone of the newest snapshot instead of promoting it', () => {
  const entries = [
    buildMockZfsEntry({ name: 'tank/imp/retired/r' }),
    buildMockZfsEntry({ name: 'tank/imp/retired/r@cp-old', type: 'snapshot', deferDestroy: true }),
    buildMockZfsEntry({ name: 'tank/imp/disks/b', origin: 'tank/imp/retired/r@cp-old' }),
    buildMockZfsEntry({
      name: 'tank/imp/retired/r@bk-run-a',
      type: 'snapshot',
      deferDestroy: true,
    }),
    buildMockZfsEntry({ name: 'tank/imp/staging/bk-a', origin: 'tank/imp/retired/r@bk-run-a' }),
  ];

  expect(
    planReclaimStep(entries, { retired: 'tank/imp/retired', staging: 'tank/imp/staging' }),
  ).toBeNull();
});

test('it promotes a fork of the newest snapshot beside a staging clone of it', () => {
  const entries = [
    buildMockZfsEntry({ name: 'tank/imp/retired/r' }),
    buildMockZfsEntry({ name: 'tank/imp/retired/r@cp-old', type: 'snapshot', deferDestroy: true }),
    buildMockZfsEntry({ name: 'tank/imp/disks/b', origin: 'tank/imp/retired/r@cp-old' }),
    buildMockZfsEntry({
      name: 'tank/imp/retired/r@bk-run-a',
      type: 'snapshot',
      deferDestroy: true,
    }),
    buildMockZfsEntry({ name: 'tank/imp/staging/bk-a', origin: 'tank/imp/retired/r@bk-run-a' }),
    buildMockZfsEntry({ name: 'tank/imp/disks/c', origin: 'tank/imp/retired/r@bk-run-a' }),
  ];

  expect(
    planReclaimStep(entries, { retired: 'tank/imp/retired', staging: 'tank/imp/staging' }),
  ).toStrictEqual({ kind: 'promote', name: 'tank/imp/disks/c' });
});
