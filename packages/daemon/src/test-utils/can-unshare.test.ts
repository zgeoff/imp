import { expect, test } from 'bun:test';
import { updateEnv } from '@imp/test-utils/update-env';
import { canUnshare } from './can-unshare';

test('it answers yes for a failing command when host tests are required', () => {
  updateEnv('IMP_HOST_TESTS', 'required');

  expect(canUnshare(['false'])).toBeTrue();
});

test('it answers no for a command that fails in the namespace', () => {
  updateEnv('IMP_HOST_TESTS', undefined);

  expect(canUnshare(['false'])).toBeFalse();
});

test('it answers no for a command that does not exist', () => {
  updateEnv('IMP_HOST_TESTS', undefined);

  expect(canUnshare(['imp-no-such-command'])).toBeFalse();
});

// the namespace this machine allows, asked of unshare directly
test.skipIf(Bun.spawnSync(['unshare', '-rn', 'true']).exitCode !== 0)(
  'it answers yes for a command that succeeds in the namespace',
  () => {
    updateEnv('IMP_HOST_TESTS', undefined);

    expect(canUnshare(['true'])).toBeTrue();
  },
);
