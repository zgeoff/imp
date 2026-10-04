import { AgentError } from './agent-connection';

interface Feature {
  readonly since: readonly [number, number];
  readonly missing: string;

  // a version that is missing or does not parse fails the check, where
  // the agent's own answer settles other features
  readonly strict?: true;
}

// What a newer agent can do, and the first protocol version with it.
// `ssh` is the dial op and `imp-agent sftp` on the system drive.
const FEATURES = {
  sessions: { since: [0, 2], missing: 'no sessions' },
  ssh: { since: [0, 3], missing: 'no port forwarding or SFTP' },
  'agent-forwarding': { since: [0, 4], missing: 'no ssh-agent forwarding' },
  grow: { since: [0, 5], missing: 'no online disk grow' },
  'unix-dial-as-user': { since: [0, 6], missing: 'no safe unix socket forwarding' },
  cp: { since: [0, 7], missing: 'no imp cp' },
  'reverse-forward': { since: [0, 9], missing: 'no reverse forwards' },
  services: { since: [0, 10], missing: 'no services API' },

  // an older agent answers the op with UNKNOWN_OP; strict all the same,
  // as a field it ignores would run the command in the container as root
  'outer-exec': {
    since: [0, 16],
    missing: 'no exec --agent',
    strict: true,
  },

  // an older agent fixes the inner container's limit at its boot size, so
  // its user processes are OOM-killed in memory the guest grew into
  'elastic-memory': {
    since: [0, 17],
    missing: 'no elastic memory, so its programs could not use a grow',
    strict: true,
  },

  // session.tap, for impd's session logs; an older agent ignores `log` on a
  // start and answers the tap UNKNOWN_OP
  'session-log': { since: [0, 18], missing: 'no session logs' },
} as const satisfies Record<string, Feature>;

export type AgentFeature = keyof typeof FEATURES;

// a woken imp keeps the agent it booted with, until its next cold boot
export function buildAgentOutdatedError(feature: AgentFeature): AgentError {
  return new AgentError(
    'AGENT_OUTDATED',
    `the imp's agent has ${FEATURES[feature].missing} yet; stop and start the imp to update it`,
  );
}

// a strict feature with no recorded version: impd failed to write the imp's
// vm.json at its boot (it logs why), or the imp booted before impd kept it
export function buildAgentUnknownError(feature: AgentFeature): AgentError {
  return new AgentError(
    'AGENT_OUTDATED',
    `impd has no record of the imp's agent version, so it takes it to have ${FEATURES[feature].missing}; stop and start the imp to record it`,
  );
}

// false for an agent version from before the feature; a missing version
// (an imp booted before impd recorded them) or one that does not parse
// passes unless the feature is strict, and the agent's answer settles it
export function hasFeature(agentVersion: string | undefined, feature: AgentFeature): boolean {
  const known: Feature = FEATURES[feature];
  const [major, minor] = (agentVersion ?? '').split('.').map(Number);
  const [sinceMajor, sinceMinor] = known.since;

  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) {
    return known.strict !== true;
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
