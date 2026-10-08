import { SUITES } from './suites';

// The prefix for a suite file's imp names, and every other resource it names.
// main.ts resets the baseline after each suite; a suite file run alone gets
// no reset (reset-baseline.ts is the utility, which no suite calls yet).
export function setupSuite(name: string): string {
  const suite = SUITES.find((candidate) => candidate.name === name);

  if (suite === undefined) {
    throw new Error(`no suite named ${name}`);
  }

  return suite.prefix;
}
