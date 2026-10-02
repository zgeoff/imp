import type { Session } from '@imp/api';
import { findSignalName } from '../exec/signal-names';
import type { SeenSession } from './session-cache';

export function toApiSession(session: Readonly<SeenSession>): Session {
  const api: Session = {
    name: session.name,
    pid: session.pid,
    argv: [...session.argv],
    state: session.state,
    attached: session.attached,
    cols: session.cols,
    rows: session.rows,
    startedAt: new Date(session.started_unix_ms),
    continuity: session.execution_generation === undefined ? 'none' : 'offsets',
    ...(session.execution_generation !== undefined && {
      executionGeneration: session.execution_generation,
    }),
    ...(session.boot_id !== undefined && { bootId: session.boot_id }),
    ...(session.end !== undefined && { end: session.end }),
    ...(session.end !== undefined &&
      session.observed_unix_ms !== undefined && {
        endObservedAt: new Date(session.observed_unix_ms),
      }),
  };

  if (session.exit !== undefined) {
    const signalled = session.exit.signal !== 0;

    api.exit = {
      code: signalled ? null : session.exit.code,
      signal: signalled ? findSignalName(session.exit.signal) : null,
    };
  }

  return api;
}
