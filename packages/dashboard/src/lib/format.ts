import type { Imp } from '@impz/client';
import { formatBytes, formatMib } from '@impz/shared';

const RELATIVE_STEPS = [
  { limit: 60, divisor: 1, unit: 's' },
  { limit: 3600, divisor: 60, unit: 'm' },
  { limit: 86_400, divisor: 3600, unit: 'h' },
  { limit: Number.POSITIVE_INFINITY, divisor: 86_400, unit: 'd' },
] as const;

// "12s ago", "3h ago"; a time in the future reads "in 5m"
export function formatRelativeTime(date: Readonly<Date>, nowMs: number): string {
  const seconds = Math.round((nowMs - date.getTime()) / 1000);
  const size = Math.abs(seconds);
  const step = RELATIVE_STEPS.find((candidate) => size < candidate.limit) ?? RELATIVE_STEPS[3];
  const amount = `${String(Math.floor(size / step.divisor))}${step.unit}`;

  return seconds >= 0 ? `${amount} ago` : `in ${amount}`;
}

// the last sample's CPU, in percent of one core, over the limit when there is
// one: "45% / 1.5"
export function formatCpuUse(imp: Imp): string {
  const percent = imp.resources?.sample?.cpuPercent;
  const used = percent === undefined ? '—' : `${percent.toFixed(0)}%`;
  const limit = imp.cpu?.limit ?? null;

  return limit === null ? used : `${used} / ${String(limit)}`;
}

// what the imp's storage takes over its disk size: "≤1.2 GiB / 32 GiB"; ≤
// when a fork holds a snapshot of it, ? when the last pass was cut short
export function formatDiskUse(imp: Imp): string {
  const size = formatMib(imp.diskMib);
  const usage = imp.diskUsage;

  if (usage === undefined) {
    return `— / ${size}`;
  }

  const bound = usage.isUpperBound ? '≤' : '';
  const partial = usage.isPartial ? '?' : '';

  return `${bound}${formatBytes(usage.exclusiveBytes)}${partial} / ${size}`;
}
