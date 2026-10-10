import * as z from 'zod';
import { runImp } from './imp-cli';

// The api audit rows of one imp, newest first, as `imp audit --json` prints
// them.

const AuditCallsSchema = z.array(
  z.object({
    at: z.string(),
    procedure: z.string(),
    actor: z.string(),
    outcome: z.string(),
    durationMs: z.number(),
  }),
);

export type AuditCall = z.infer<typeof AuditCallsSchema>[number];

export function parseAuditCalls(json: string): AuditCall[] {
  return AuditCallsSchema.parse(JSON.parse(json));
}

// The rows ahead of the newest row from before, not a clock's: a read holds
// at most its limit of rows, so new rows push old ones out of `after`.
export function pickNewCalls(
  after: readonly AuditCall[],
  before: readonly AuditCall[],
): AuditCall[] {
  const [newest] = before;

  if (newest === undefined) {
    return [...after];
  }

  const added = after.findIndex((call) => JSON.stringify(call) === JSON.stringify(newest));

  if (added === -1) {
    throw new Error(`the newest audit row from before is gone: ${JSON.stringify(newest)}`);
  }

  const kept = after.slice(added);

  if (JSON.stringify(kept) !== JSON.stringify(before.slice(0, kept.length))) {
    throw new Error(`the audit rows from before changed: ${JSON.stringify(kept)}`);
  }

  return after.slice(0, added);
}

// Thin glue over the CLI below.

export async function readAuditCalls(name: string): Promise<AuditCall[]> {
  const json = await runImp('audit', name, '--kind', 'api', '--json');

  return parseAuditCalls(json);
}
