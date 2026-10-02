import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { runCommand } from 'citty';
import { checkpointCommand } from './checkpoints';
import { imageCommand } from './image';

// These fail before any call to impd, so they need none: IMP_URL points
// nowhere, and a call that slipped through would fail with another message.

beforeEach(() => {
  process.env['IMP_URL'] = 'http://127.0.0.1:1';
  process.exitCode = 0;
});

afterEach(() => {
  mock.restore();
  delete process.env['IMP_URL'];
  process.exitCode = 0;
});

function setupStderr() {
  return spyOn(console, 'error').mockImplementation(() => {
    // captured
  });
}

test('checkpoint rm with too few arguments fails instead of creating a checkpoint', async () => {
  const stderr = setupStderr();

  await runCommand(checkpointCommand, { rawArgs: ['rm', 'box'] });

  expect(stderr).toHaveBeenCalledWith('imp: usage: imp checkpoint rm <name> <checkpoint>');
  expect(process.exitCode).toBe(1);
});

test('image build rejects a relative path, which names no directory on the impd host', async () => {
  const stderr = setupStderr();

  await runCommand(imageCommand, { rawArgs: ['build', 'images/base', '--name', 'base'] });

  expect(stderr).toHaveBeenCalledWith(
    'imp: the build context is a directory on the impd host: give its absolute path, not images/base',
  );

  expect(process.exitCode).toBe(1);
});
