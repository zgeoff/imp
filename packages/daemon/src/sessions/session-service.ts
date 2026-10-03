import type { Session, SessionLog, SessionLogRead } from '@imp/api';
import { AgentError } from '../agent-client/agent-connection';
import { sendActivity, sendSessionKill } from '../agent-client/agent-requests';
import { buildAgentOutdatedApiError, buildNotFoundError } from '../api-errors';
import { updateImpActivity } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpContext } from '../imps/imp-context';
import type { ImpLock } from '../imps/imp-lock';
import type { ImpRuntime } from '../imps/imp-runtime';
import { findSessionLogImp } from '../session-logs/find-session-log-imp';
import type { SessionLogReadRequest } from '../session-logs/session-log-files';
import type { SessionLogTarget } from '../session-logs/session-log-service';
import { readSeenSessions } from './count-sessions';
import { toSeenSessions } from './session-cache';
import { toApiSession } from './to-api-session';

// The `sessions` API (docs/architecture/protocol.md#sessions). The sessions
// live in the guest; impd keeps what it last saw, so a list never wakes an
// imp.
export interface SessionService {
  readonly listSessions: (name: string) => Promise<Session[]>;
  readonly killSession: (name: string, session: string) => Promise<void>;

  // the session logs live on the host: none of these wakes or boots the imp
  readonly listSessionLogs: (name: string, session?: string) => Promise<SessionLog[]>;
  readonly readSessionLog: (
    name: string,
    request: Readonly<SessionLogReadRequest>,
  ) => Promise<SessionLogRead>;
  readonly deleteSessionLogs: (name: string, target: Readonly<SessionLogTarget>) => Promise<number>;
}

interface SessionServiceParts {
  readonly context: ImpContext;
  readonly lock: Pick<ImpLock, 'findImp'>;
  readonly requireRunning: ImpRuntime['requireRunning'];
}

export function createSessionService(parts: SessionServiceParts): SessionService {
  const context = parts.context;

  // a running imp's agent answers now; one that does not falls back to
  // what impd saw last
  const readSessions = async (imp: ImpRecord) => {
    if (imp.state === 'running') {
      try {
        const activity = await sendActivity(context.findPaths(imp.id).vsockSocket);

        const seen = toSeenSessions(activity.sessions, new Date());

        context.sessions.record(imp.id, seen);
        context.sessionLogs.observe(findSessionLogImp(context.findPaths, imp), activity.sessions);

        return seen;
      } catch {
        // the agent is busy or wedged
      }
    }

    return readSeenSessions(context, imp) ?? [];
  };

  const findLogImp = async (name: string) => {
    const imp = await parts.lock.findImp(name);

    return findSessionLogImp(context.findPaths, imp);
  };

  return {
    listSessionLogs: async (name, session) => {
      const imp = await findLogImp(name);

      return context.sessionLogs.listLogs(imp, session);
    },
    readSessionLog: async (name, request) => {
      const imp = await findLogImp(name);

      return context.sessionLogs.readLog(imp, request);
    },
    deleteSessionLogs: async (name, target) => {
      const imp = await findLogImp(name);

      return context.sessionLogs.deleteLogs(imp, target);
    },

    listSessions: async (name) => {
      const imp = await parts.lock.findImp(name);
      const sessions = await readSessions(imp);

      return sessions.map((session) => toApiSession(session));
    },

    killSession: async (name, session) => {
      const opened = { release: () => {} };

      try {
        // counted like an exec, so no background sleep lands mid-kill
        const running = await parts.requireRunning(name, (found) => {
          opened.release = context.tracker.open(found.id, 'exec');
        });

        const imp = running.imp;

        await updateImpActivity(context.db, imp.id, new Date());

        await sendSessionKill(context.findPaths(imp.id).vsockSocket, session).catch(
          (error: unknown) => {
            if (error instanceof AgentError && error.code === 'NO_SESSION') {
              throw buildNotFoundError('session', session);
            }

            if (error instanceof AgentError && error.code === 'AGENT_OUTDATED') {
              throw buildAgentOutdatedApiError(error.message);
            }

            throw error;
          },
        );

        const seen = context.sessions.read(imp.id);

        if (seen !== undefined) {
          context.sessions.record(
            imp.id,
            seen.filter((entry) => entry.name !== session),
          );
        }
      } finally {
        opened.release();
      }
    },
  };
}
