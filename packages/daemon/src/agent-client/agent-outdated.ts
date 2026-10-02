import { AgentError } from './agent-connection';

// the first agent protocol with sessions
const SESSIONS_SINCE = [0, 2] as const;

// a woken imp keeps the agent it booted with, until its next cold boot
export function buildAgentOutdatedError(): AgentError {
  return new AgentError(
    'AGENT_OUTDATED',
    "the imp's agent has no sessions yet; stop and start the imp to update it",
  );
}

// false for an agent version from before sessions; true for one that does
// not parse, which the agent's own answer then settles
export function hasSessions(agentVersion: string): boolean {
  const [major, minor] = agentVersion.split('.').map(Number);

  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) {
    return true;
  }

  return major > SESSIONS_SINCE[0] || (major === SESSIONS_SINCE[0] && minor >= SESSIONS_SINCE[1]);
}

// an agent from before sessions answers a session op with UNKNOWN_OP
export function handleUnknownOp(error: unknown): never {
  if (error instanceof AgentError && error.code === 'UNKNOWN_OP') {
    throw buildAgentOutdatedError();
  }

  throw error;
}
