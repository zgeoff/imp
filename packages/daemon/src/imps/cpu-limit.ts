import { ORPCError } from '@orpc/server';
import type { CpuSettings } from '../db/imps';

// below this the VMM thread starves and a boot times out
const MIN_CPU_LIMIT = 0.1;
const DEFAULT_CPU_WEIGHT = 100;

interface CpuInput {
  readonly cpuLimit?: number | null | undefined;
  readonly cpuWeight?: number | undefined;
}

// `input` over `current` (the defaults for a new imp), checked against the
// host: a limit past its cores could never bind
export function resolveCpuSettings(
  input: CpuInput,
  current: CpuSettings | null,
  hostCpus: number,
): CpuSettings {
  const limit = input.cpuLimit === undefined ? (current?.limit ?? null) : input.cpuLimit;
  const weight = input.cpuWeight ?? current?.weight ?? DEFAULT_CPU_WEIGHT;

  if (limit !== null && (limit < MIN_CPU_LIMIT || limit > hostCpus)) {
    throw new ORPCError('BAD_REQUEST', {
      message: `a CPU limit is from ${String(MIN_CPU_LIMIT)} to the host's ${String(hostCpus)} cores`,
    });
  }

  if (!Number.isInteger(weight) || weight < 1 || weight > 10_000) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'a CPU weight is a whole number from 1 to 10000',
    });
  }

  return { limit, weight };
}
