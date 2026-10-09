import { expect, test } from 'bun:test';
import { isCompatibleVersion } from './check-server';

test('it accepts an impd of the same minor version before 1.0', () => {
  expect(isCompatibleVersion('0.3.1', '0.3.7')).toBeTrue();
});

test('it refuses an impd of another minor version before 1.0', () => {
  expect(isCompatibleVersion('0.3.1', '0.4.0')).toBeFalse();
});

test('it accepts an impd of the same major version from 1.0', () => {
  expect(isCompatibleVersion('1.2.0', '1.9.3')).toBeTrue();
});

test('it refuses an impd of another major version from 1.0', () => {
  expect(isCompatibleVersion('1.2.0', '2.0.0')).toBeFalse();
});

test('it refuses a version it cannot read', () => {
  expect(isCompatibleVersion('0.3.1', 'dev')).toBeFalse();
});
