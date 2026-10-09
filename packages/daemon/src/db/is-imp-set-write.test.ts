import { expect, test } from 'bun:test';
import { buildMockCheckpointRecord } from '../test-utils/build-mock-checkpoint-record';
import { buildMockImpRecord } from '../test-utils/build-mock-imp-record';
import { isImpSetWrite } from './is-imp-set-write';

test('it resyncs the imp set for a create', () => {
  expect(isImpSetWrite({ kind: 'added', imp: buildMockImpRecord() })).toBeTrue();
});

test('it resyncs the imp set for a destroy', () => {
  expect(isImpSetWrite({ kind: 'removed', imp: buildMockImpRecord() })).toBeTrue();
});

test.each([
  ['resyncs', 'stopped', true],
  ['leaves alone', 'slept', false],
  ['leaves alone', 'booted', false],
] as const)('it %s the imp set for a %s change', (_verdict, reason, expected) => {
  expect(isImpSetWrite({ kind: 'changed', imp: buildMockImpRecord(), reason })).toBe(expected);
});

test('it leaves the imp set alone for a checkpoint write', () => {
  expect(
    isImpSetWrite({ kind: 'checkpointAdded', checkpoint: buildMockCheckpointRecord() }),
  ).toBeFalse();
});
