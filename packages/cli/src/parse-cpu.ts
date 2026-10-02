import { UsageError } from './usage-error';

// `--cpu-limit 1.5` in cores, or `none` to take the limit away
export function parseCpuLimit(text: string): number | null {
  if (text.trim() === 'none') {
    return null;
  }

  const cores = Number(text);

  if (!/^\d*\.?\d+$/.test(text.trim()) || cores < 0.1) {
    throw new UsageError(
      `--cpu-limit takes cores, at least 0.1 (such as 1.5), or none, not ${text}`,
    );
  }

  return cores;
}

// `--cpu-weight`: the share under contention, 1 to 10000; 100 is the default
export function parseCpuWeight(text: string): number {
  const weight = Number(text);

  if (!/^\d+$/.test(text.trim()) || weight < 1 || weight > 10_000) {
    throw new UsageError(`--cpu-weight takes a whole number from 1 to 10000, not ${text}`);
  }

  return weight;
}
