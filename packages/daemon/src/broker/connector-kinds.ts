import type { BrokerRule, SecretKind } from '@imp/api';

// The presets behind `imp secret add --kind`: each host's header, and the
// variables a tool checks before it sends anything (gh with none stops at
// `gh auth login`). They hold a placeholder; the broker sets the real value.

interface Preset {
  readonly rules: readonly BrokerRule[];
  readonly env: readonly string[];
}

// what the guest holds in place of a secret
export const PLACEHOLDER = 'imp-broker-placeholder';

const PRESETS: Readonly<Record<Exclude<SecretKind, 'custom' | 'oauth'>, Preset>> = {
  // git smart HTTP on github.com takes Basic auth; the REST and upload APIs
  // take a bearer token
  github: {
    rules: [
      { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
      { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
      { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
    ],
    env: ['GH_TOKEN', 'GITHUB_TOKEN'],
  },
  anthropic: {
    rules: [{ host: 'api.anthropic.com', header: 'x-api-key', scheme: 'raw' }],
    env: ['ANTHROPIC_API_KEY'],
  },
  npm: {
    rules: [{ host: 'registry.npmjs.org', header: 'authorization', scheme: 'bearer' }],
    env: ['NPM_TOKEN'],
  },
};

export class SecretRulesError extends Error {
  override name = 'SecretRulesError';
}

// The rules a secret of this kind gets: a preset's own, or the caller's
// for `custom` and `oauth`. Two rules for one host would leave the header ambiguous.
export function resolveRules(
  kind: SecretKind,
  given: readonly BrokerRule[] | undefined,
): readonly BrokerRule[] {
  if (kind !== 'custom' && kind !== 'oauth') {
    if (given !== undefined) {
      throw new SecretRulesError(
        `kind ${kind} has its own hosts; rules are for kinds custom and oauth`,
      );
    }

    return PRESETS[kind].rules;
  }

  if (given === undefined || given.length === 0) {
    throw new SecretRulesError(`kind ${kind} needs at least one host`);
  }

  const hosts = given.map((rule) => rule.host);
  const repeated = hosts.find((host, index) => hosts.indexOf(host) !== index);

  if (repeated !== undefined) {
    throw new SecretRulesError(`${repeated} has more than one rule`);
  }

  return given;
}

// the placeholder variables for these kinds, each once
export function listPlaceholderEnv(kinds: readonly SecretKind[]): readonly string[] {
  const names = kinds.flatMap((kind) =>
    kind === 'custom' || kind === 'oauth' ? [] : PRESETS[kind].env,
  );

  return [...new Set(names)];
}

// the header value the broker sets
export function renderCredential(rule: Readonly<BrokerRule>, value: string): string {
  if (rule.scheme === 'bearer') {
    return `Bearer ${value}`;
  }

  if (rule.scheme === 'basic') {
    return `Basic ${Buffer.from(`${rule.user ?? ''}:${value}`).toString('base64')}`;
  }

  return value;
}
