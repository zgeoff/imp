import { readFileSync } from 'node:fs';
import type { JsonValue } from '@bufbuild/protobuf';
import * as z from 'zod';

// One of the agent's contract fixtures (agent/internal/contract), by its path
// under testdata: `guest/ping.json`, `host/requests/exec.json`.
export function readAgentFixture(path: string): JsonValue {
  const url = new URL(`../../../agent/internal/contract/testdata/${path}`, import.meta.url);

  return z.json().parse(JSON.parse(readFileSync(url, 'utf8')));
}
