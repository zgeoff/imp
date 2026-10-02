import { AgentError } from './agent-connection';

// What a newer agent can do, and the first protocol version with it.
// `ssh` is the dial op and `imp-agent sftp` on the system drive.
const FEATURES = {
  sessions: { since: [0, 2], missing: 'no sessions' },
  ssh: { since: [0, 3], missing: 'no port forwarding or SFTP' },
} as const;

export type AgentFeature = keyof typeof FEATURES;

// a woken imp keeps the agent it booted with, until its next cold boot
export function buildAgentOutdatedError(feature: AgentFeature): AgentError {
  return new AgentError(
    'AGENT_OUTDATED',
    `the imp's agent has ${FEATURES[feature].missing} yet; stop and start the imp to update it`,
  );
}

// false for an agent version from before the feature; true for one that does
// not parse, which the agent's own answer then settles
export function hasFeature(agentVersion: string, feature: AgentFeature): boolean {
  const [major, minor] = agentVersion.split('.').map(Number);
  const [sinceMajor, sinceMinor] = FEATURES[feature].since;

  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) {
    return true;
  }

  return major > sinceMajor || (major === sinceMajor && minor >= sinceMinor);
}

// an agent from before a feature answers its op with UNKNOWN_OP
export function handleUnknownOp(feature: AgentFeature): (error: unknown) => never {
  return (error) => {
    if (error instanceof AgentError && error.code === 'UNKNOWN_OP') {
      throw buildAgentOutdatedError(feature);
    }

    throw error;
  };
}
