import type { AgentInner } from '../agent-client/agent-protocol';

// The inner container of each awake imp as its agent's ping last reported
// it: the idle loop asks every pass, so `imp ls` reads it without a call into
// each guest. Live state: impd keeps it in memory only.
export interface InnerCache {
  readonly record: (impId: string, inner: AgentInner) => void;

  // undefined until the agent answered a ping with it since the imp woke
  readonly read: (impId: string) => AgentInner | undefined;

  // the agent did not answer, or the VM no longer runs
  readonly forget: (impId: string) => void;
}

export function createInnerCache(): InnerCache {
  const inners = new Map<string, AgentInner>();

  return {
    record: (impId, inner) => {
      inners.set(impId, inner);
    },
    read: (impId) => inners.get(impId),
    forget: (impId) => {
      inners.delete(impId);
    },
  };
}
