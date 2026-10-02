import * as z from 'zod';
import { AgentSessionObjectSchema } from '../agent-client/agent-requests';
import type { AgentSession } from '../agent-client/agent-requests';

// a session as impd last saw it: `observed_unix_ms` is when, so its `end`
// is a lower bound as of then; left out by an impd from before offsets
export const SeenSessionSchema = AgentSessionObjectSchema.extend({
  observed_unix_ms: z.int().optional(),
}).readonly();

export type SeenSession = z.infer<typeof SeenSessionSchema>;

// The sessions of each awake imp as impd last saw them: the idle loop asks
// every agent every pass, so `imp ls` counts sessions without a call into
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
export function toSeenSessions(list: readonly AgentSession[], at: Date): SeenSession[] {
  return list.map((session) => ({ ...session, observed_unix_ms: at.getTime() }));
}
