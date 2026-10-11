import { expect, test } from 'bun:test';
import { readImpEnv } from './read-imp-env';
import { updateEnv } from './update-env';

test('it reads an IMP_ variable the test set', () => {
  updateEnv('IMP_RAM_BUDGET_MIB', '800');

  expect(readImpEnv()).toContainEntry(['IMP_RAM_BUDGET_MIB', '800']);
});

test('it leaves out a variable without the IMP_ prefix', () => {
  updateEnv('TAILSCALE_AUTHKEY', 'tskey-test');

  expect(readImpEnv()).not.toContainKey('TAILSCALE_AUTHKEY');
});
