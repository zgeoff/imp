import { config } from './config';

// Timing limits belong to the definition of done. Other runs, such as CI on
// shared runners, report a miss instead of failing on it.
export function checkLimit(what: string, ms: number, limitMs: number): void {
  if (ms <= limitMs) {
    return;
  }

  const message = `${what} took ${String(ms)} ms, over the ${String(limitMs)} ms limit`;

  if (config.acceptance) {
    throw new Error(message);
  }

  console.log(`    warning: ${message}`);
}
