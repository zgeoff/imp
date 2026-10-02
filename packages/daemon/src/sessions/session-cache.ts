import type { AgentSession } from '../agent-client/agent-requests';

// The sessions of each awake imp as impd last saw them: the idle loop asks
// every agent every pass, so `imp ls` counts sessions without a call into
// each guest. A sleeping imp's sessions are in its snapshot meta instead.
export interface SessionCache {
  readonly record: (impId: string, sessions: readonly AgentSession[]) => void;

  // undefined until impd has seen the imp's agent since it last booted
  readonly read: (impId: string) => readonly AgentSession[] | undefined;

  // the VM is gone, and its sessions with it
  readonly forget: (impId: string) => void;
}

export function createSessionCache(): SessionCache {
  const sessions = new Map<string, readonly AgentSession[]>();

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
