export function formatTimings(timings: Readonly<Record<string, number>>): string {
  return Object.entries(timings)
    .map(([step, ms]) => `${step}=${String(ms)}ms`)
    .join(' ');
}
