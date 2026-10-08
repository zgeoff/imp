import { SUITES } from './suites';

// The prefix for a suite file's imp names, and every other resource it
// names. The outer harness (main.ts) resets the baseline after each suite;
// a journey resets it itself through reset-baseline.ts.
export function setupSuite(name: string): string {
  const suite = SUITES.find((candidate) => candidate.name === name);

  if (suite === undefined) {
    throw new Error(`no suite named ${name}`);
  }

  return suite.prefix;
}
