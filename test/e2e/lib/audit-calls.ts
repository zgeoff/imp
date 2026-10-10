import * as z from 'zod';
import { runImp } from './imp-cli';

// The api audit rows of one imp, newest first, as `imp audit --json` prints
// them.

const AuditCallsSchema = z.array(
  z.object({ at: z.string(), procedure: z.string(), actor: z.string() }),
);

export type AuditCall = z.infer<typeof AuditCallsSchema>[number];

export function parseAuditCalls(json: string): AuditCall[] {
  return AuditCallsSchema.parse(JSON.parse(json));
}

// The rows a journey added since `before`: an instance keeps an earlier
// run's rows for the same name, so the journey compares against them, not
// against a clock. Throws when the earlier rows changed.
export function pickNewCalls(
  after: readonly AuditCall[],
  before: readonly AuditCall[],
): AuditCall[] {
  const added = after.length - before.length;
  const kept = after.slice(Math.max(added, 0));

  if (added < 0 || JSON.stringify(kept) !== JSON.stringify(before)) {
    throw new Error(`the audit rows from before changed: ${JSON.stringify(kept)}`);
  }

  return after.slice(0, added);
}

// Thin glue over the CLI below.

export async function readAuditCalls(name: string): Promise<AuditCall[]> {
  const json = await runImp('audit', name, '--kind', 'api', '--json');

  return parseAuditCalls(json);
}
