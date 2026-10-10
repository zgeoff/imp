import { readSuitePrefix } from './suites';

// A suite file's prefix, for the files not yet split into journeys; a
// journey file reads it with readSuitePrefix. It registers no hooks: main.ts
// resets the baseline after each journey file.
export function setupSuite(name: string): string {
  return readSuitePrefix(name);
}
