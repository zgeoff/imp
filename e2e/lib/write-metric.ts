import { appendFileSync } from 'node:fs';
import { config } from './config';

// Prints a metric and adds it to the run's results.json. Suites run in their
// own processes, so each appends a JSON line that the runner merges.
export function writeMetric(key: string, value: unknown): void {
  console.log(`    ${key}: ${JSON.stringify(value)}`);

  if (config.metricsFile !== null) {
    appendFileSync(config.metricsFile, `${JSON.stringify({ [key]: value })}\n`);
  }
}
