import { expect, test } from 'bun:test';
import { toSignalExitCode } from './to-signal-exit-code';

test.each([
  ['SIGINT', 130],
  ['SIGKILL', 137],
  ['SIGTERM', 143],
  ['SIG34', 162],
])('it gives %s the exit code %d, as a shell reports it', (signal, code) => {
  expect(toSignalExitCode(signal)).toBe(code);
});

test('it gives no exit code for a signal with no number', () => {
  expect(toSignalExitCode('SIGNOPE')).toBeNull();
});
