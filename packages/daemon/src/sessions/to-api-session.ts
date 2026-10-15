import type { Session } from '@impz/api';
import { isAgentSessionState } from '../agent-client/is-agent-session-state';
import { findSignalName } from '../exec/signal-names';
import type { SeenSession } from './session-cache';

export function toApiSession(session: SeenSession): Session {
  const hasOffsets = session.executionGeneration !== '';

  const api: Session = {
    name: session.name,
    pid: session.pid,
    argv: [...session.argv],
    state: getSessionState(session.state),
    attached: session.attached,
    cols: session.cols,
    rows: session.rows,
    startedAt: new Date(session.startedUnixMs),

    // an agent from before output offsets leaves the generation, the boot
    // and the end out
    continuity: hasOffsets ? 'offsets' : 'none',
    ...(hasOffsets && {
      executionGeneration: session.executionGeneration,
      bootId: session.bootId,
      end: session.end,
    }),
    ...(hasOffsets &&
      session.observedUnixMs !== undefined && {
        endObservedAt: new Date(session.observedUnixMs),
      }),
    ...(session.log === true && { log: true }),
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

// impd keeps only the sessions whose state it knows (parseAgentActivity)
function getSessionState(state: string): Session['state'] {
  if (!isAgentSessionState(state)) {
    throw new Error(`a session in state ${JSON.stringify(state)}`);
  }

  return state;
}
