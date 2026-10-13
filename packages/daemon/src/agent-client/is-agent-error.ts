import { AgentError } from './agent-connection';
import type { AgentErrorCode } from './agent-protocol';

// an AgentError with one of `codes`: the agent's own, or AGENT_OUTDATED,
// which impd gives for an agent from before a feature
export function isAgentError(
  error: unknown,
  ...codes: readonly (AgentErrorCode | 'AGENT_OUTDATED')[]
): error is AgentError {
  return error instanceof AgentError && codes.some((code) => code === error.code);
}
