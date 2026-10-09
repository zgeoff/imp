import { expect, test } from 'bun:test';
import { buildMockZfsEntry } from './build-mock-zfs-entry';

test('it builds a default zfs entry', () => {
  expect(buildMockZfsEntry()).toStrictEqual({
    name: expect.toStartWith('tank/imp/disks/'),
    type: 'filesystem',
    origin: null,
    deferDestroy: false,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockZfsEntry({
      name: 'tank/imp/disks/a@cp-1',
      type: 'snapshot',
      origin: 'tank/imp/images/abc@base',
      deferDestroy: true,
    }),
  ).toStrictEqual({
    name: 'tank/imp/disks/a@cp-1',
    type: 'snapshot',
    origin: 'tank/imp/images/abc@base',
    deferDestroy: true,
  });
});
