import { parseCpuLimit, parseCpuWeight } from '../parse/parse-cpu';

export const cpuLimitArg = {
  type: 'string',
  description: 'cores the VM may use, such as 1.5, or none (default none)',
} as const;

export const cpuWeightArg = {
  type: 'string',
  description: 'share of the host under contention, 1 to 10000 (default 100)',
} as const;

interface CpuArgs {
  readonly 'cpu-limit'?: string | undefined;
  readonly 'cpu-weight'?: string | undefined;
}

export function readCpuArgs(args: CpuArgs) {
  return {
    ...(args['cpu-limit'] !== undefined && { cpuLimit: parseCpuLimit(args['cpu-limit']) }),
    ...(args['cpu-weight'] !== undefined && { cpuWeight: parseCpuWeight(args['cpu-weight']) }),
  };
}
