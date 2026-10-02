import { expect, test } from 'bun:test';
import { isCompatibleVersion } from './check-server';

test('it matches the minor version before 1.0', () => {
  expect(isCompatibleVersion('0.3.1', '0.3.7')).toBeTrue();
  expect(isCompatibleVersion('0.3.1', '0.4.0')).toBeFalse();
});

test('it matches the major version from 1.0', () => {
  expect(isCompatibleVersion('1.2.0', '1.9.3')).toBeTrue();
  expect(isCompatibleVersion('1.2.0', '2.0.0')).toBeFalse();
});

test('it refuses a version it cannot read', () => {
  expect(isCompatibleVersion('0.3.1', 'dev')).toBeFalse();
});
