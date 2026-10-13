import { readdirSync } from 'node:fs';

// The names, without .json, of the agent's contract fixtures in one
// directory under agent/internal/contract/testdata, sorted.
export function listAgentFixtures(dir: string): string[] {
  const url = new URL(`../../../agent/internal/contract/testdata/${dir}/`, import.meta.url);

  return readdirSync(url)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .toSorted();
}
