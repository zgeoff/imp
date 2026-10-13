import { readFileSync } from 'node:fs';

// One of the agent's contract fixtures (agent/internal/contract), by its path
// under testdata: `guest/ping.json`, `host/requests/exec.json`.
export function readAgentFixture(path: string): unknown {
  const url = new URL(`../../../agent/internal/contract/testdata/${path}`, import.meta.url);

  return JSON.parse(readFileSync(url, 'utf8'));
}
