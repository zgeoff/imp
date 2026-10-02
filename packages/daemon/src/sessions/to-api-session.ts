import type { Session } from '@imp/api';
import type { AgentSession } from '../agent-client/agent-requests';
import { findSignalName } from '../exec/signal-names';

export function toApiSession(session: Readonly<AgentSession>): Session {
  const api: Session = {
    name: session.name,
    pid: session.pid,
    argv: [...session.argv],
    state: session.state,
    attached: session.attached,
    cols: session.cols,
    rows: session.rows,
    startedAt: new Date(session.started_unix_ms),
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
