import {
  EXEC_CLOSE_RESTARTING,
  IMP_ERRORS,
  InvalidResumeDataSchema,
  NoSessionDataSchema,
} from '@impz/api';
import { match } from 'ts-pattern';
import { ExecError } from './exec-error';
import { InvalidResumeError } from './invalid-resume-error';
import { InvalidStateError } from './invalid-state-error';
import { NoSessionError } from './no-session-error';
import type { ExecOutcome } from './open-exec-session';

export function toExecError(outcome: Exclude<ExecOutcome, { kind: 'exit' }>): ExecError {
  return (
    match(outcome)
      .with({ kind: 'failed' }, (failed) => toFailedError(failed.code, failed.message, failed.data))
      .with({ kind: 'unauthorized' }, (refused) => {
        const message =
          refused.ticketRefused === true
            ? 'impd refused the exec ticket: it expired (30 s) or was used already'
            : 'impd rejected the token';

        return new ExecError('UNAUTHORIZED', message);
      })
      .with(
        { kind: 'unreachable' },
        (unreachable) => new ExecError('UNREACHABLE', `cannot reach impd (${unreachable.detail})`),
      )

      // data.reason: `taken_over`, `slow` or `lost`; the session runs on.
      // With offsets, data.offset is where to resume.
      .with(
        { kind: 'detached' },
        (detached) =>
          new ExecError('DETACHED', `detached from the session (${detached.reason})`, {
            data: {
              reason: detached.reason,
              ...(detached.offset !== undefined && { offset: detached.offset }),
            },
          }),
      )
      .with({ kind: 'closed' }, (closed) =>
        closed.closeCode === EXEC_CLOSE_RESTARTING
          ? new ExecError('RESTARTING', 'impd is restarting')
          : new ExecError('CONNECTION_CLOSED', `exec connection closed (${closed.reason})`),
      )
      .with(
        { kind: 'bad_message' },
        (bad) => new ExecError('BAD_MESSAGE', `bad message from impd: ${bad.detail}`),
      )
      .with(
        { kind: 'local_error' },
        (local) => new ExecError('LOCAL_ERROR', 'an output handler threw', { cause: local.error }),
      )
      .exhaustive()
  );
}

// the three codes a session client acts on become their own classes; data
// that does not parse leaves a plain ExecError
function toFailedError(code: string | null, message: string, data: unknown): ExecError {
  if (code === 'NO_SESSION') {
    const parsed = NoSessionDataSchema.safeParse(data);
    const known = parsed.success ? parsed.data : undefined;

    return new NoSessionError(message, known);
  }

  if (code === 'INVALID_STATE') {
    const parsed = IMP_ERRORS.INVALID_STATE.data.safeParse(data);

    if (parsed.success) {
      return new InvalidStateError(message, parsed.data);
    }
  }

  if (code === 'INVALID_RESUME') {
    const parsed = InvalidResumeDataSchema.safeParse(data);

    if (parsed.success) {
      return new InvalidResumeError(message, parsed.data);
    }
  }

  return new ExecError(code ?? 'EXEC_ERROR', message, { data });
}
