const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = unit === 0 || value >= 100 ? 0 : 1;

  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`;
}

export function formatMib(mib: number): string {
  return formatBytes(mib * 1024 * 1024);
}

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
