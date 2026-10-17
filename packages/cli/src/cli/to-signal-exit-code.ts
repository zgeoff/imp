import { constants } from 'node:os';

// The exit code a shell reports for a process the signal ended: 128 + its
// number, such as 130 for SIGINT. impd names a signal Node does not know,
// a real-time one, `SIG<n>`. Null for a signal with no number.
export function toSignalExitCode(signal: string): number | null {
  const signals: Readonly<Record<string, number>> = constants.signals;
  const numbered = /^SIG(?<number>\d+)$/u.exec(signal)?.groups?.['number'];
  const number = signals[signal] ?? (numbered === undefined ? null : Number(numbered));

  return number === null ? null : 128 + number;
}
