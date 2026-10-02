import { beforeAll } from 'bun:test';
import { config } from './config';
import { createMissingImages } from './fixtures';
import { removeImpsWithPrefix, useImpCleanup } from './imps';
import { SUITES } from './suites';

// The shared top of a suite file; returns the prefix for its imp names. A
// suite file also runs on its own (`bun test ./test/e2e/suites/<name>.e2e.ts`)
// against a dev instance that is already up.
export function setupSuite(name: string): string {
  const suite = SUITES.find((candidate) => candidate.name === name);

  if (suite === undefined) {
    throw new Error(`no suite named ${name}`);
  }

  // scripts/dev.sh reads these on `up`: a suite that reboots the instance
  // must bring it back with the run's tuning
  process.env['IMP_RAM_BUDGET_MIB'] = String(config.ramBudgetMib);
  process.env['IMP_IDLE_TIMEOUT_S'] = String(config.idleTimeoutS);

  useImpCleanup();

  beforeAll(async () => {
    // --bail skips afterAll, so a failed run's imps go here
    await removeImpsWithPrefix(suite.prefix);
    await createMissingImages(suite.images);
  }, 1_800_000);

  return suite.prefix;
}
