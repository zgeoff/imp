import type { SessionInfo } from '../agent-client/agent-protocol';

// a session as impd last saw it: `observedUnixMs` is when, so its `end` is a
// lower bound as of then; unset by an impd from before offsets
export type SeenSession = SessionInfo & { readonly observedUnixMs?: number };

// The sessions of each awake imp as impd last saw them: the idle loop asks
// every agent every pass, so `impz ls` counts sessions without a call into
// each guest. A sleeping imp's sessions are in its snapshot meta instead.
export interface SessionCache {
  readonly record: (impId: string, sessions: readonly SeenSession[]) => void;

  // undefined until impd has seen the imp's agent since it last booted
  readonly read: (impId: string) => readonly SeenSession[] | undefined;

  // the VM is gone, and its sessions with it
  readonly forget: (impId: string) => void;
}

export function createSessionCache(): SessionCache {
  const sessions = new Map<string, readonly SeenSession[]>();

  return {
    record: (impId, list) => {
      sessions.set(impId, list);
    },
    read: (impId) => sessions.get(impId),
    forget: (impId) => {
      sessions.delete(impId);
    },
  };
}

// the sessions an agent just listed, seen at `at`
export function toSeenSessions(list: readonly SessionInfo[], at: Date): SeenSession[] {
  return list.map((session) => ({ ...session, observedUnixMs: at.getTime() }));
}
