import { expect, test } from 'bun:test';
import { hasScope } from './scopes';

test.each([
  ['read', 'read', true],
  ['read', 'exec', false],
  ['read', 'manage', false],
  ['exec', 'read', true],
  ['exec', 'exec', true],
  ['exec', 'manage', false],
  ['manage', 'read', true],
  ['manage', 'exec', true],
  ['manage', 'manage', true],
] as const)('it answers %s holding %s with %p', (granted, needed, held) => {
  expect(hasScope(granted, needed)).toBe(held);
});
