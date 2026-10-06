import { EgressModeSchema } from '@imp/api';
import type { EgressPolicy } from '@imp/api';
import { UsageError } from './usage-error';

// `--policy MODE` and `--allow a,b`: an allow-list alone means box, and
// only box takes one. Undefined when neither is given.
export function parsePolicy(
  mode: string | undefined,
  allow: string | undefined,
): EgressPolicy | undefined {
  if (mode === undefined && allow === undefined) {
    return undefined;
  }

  const parsed = EgressModeSchema.safeParse(mode ?? 'box');

  if (!parsed.success) {
    throw new UsageError(`the egress policy is open, public, box or none, not ${mode ?? ''}`);
  }

  const entries = (allow ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');

  if (parsed.data !== 'box' && entries.length > 0) {
    throw new UsageError(`--allow is for a box policy, not ${parsed.data}`);
  }

  return { mode: parsed.data, allow: entries };
}

export function formatPolicy(policy: EgressPolicy): string {
  return policy.mode === 'box'
    ? `box: ${policy.allow.length === 0 ? '(nothing)' : policy.allow.join(', ')}`
    : policy.mode;
}
