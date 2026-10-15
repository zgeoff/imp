import * as z from 'zod';
import { runImp } from './imp-cli';

const SessionLogRowSchema = z.object({
  session: z.string(),
  executionGeneration: z.string(),
  state: z.enum(['live', 'ended']),
  logStart: z.number(),
  logEnd: z.number(),
  bytes: z.number(),
  end: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  complete: z.boolean(),
});

export type SessionLogRow = z.infer<typeof SessionLogRowSchema>;

// `imp sessions logs <imp> --json`, with the fields the suites read
export function parseSessionLogs(stdout: string): SessionLogRow[] {
  return z.array(SessionLogRowSchema).parse(JSON.parse(stdout));
}

export async function listSessionLogs(imp: string): Promise<SessionLogRow[]> {
  const stdout = await runImp('sessions', 'logs', imp, '--json');

  return parseSessionLogs(stdout);
}

// the log of one execution generation of a session; throws when there is none
export async function requireSessionLog(imp: string, generation: string): Promise<SessionLogRow> {
  const logs = await listSessionLogs(imp);

  const found = logs.find((log) => log.executionGeneration === generation);

  if (found === undefined) {
    throw new Error(`no log of generation ${generation} in ${imp}: ${JSON.stringify(logs)}`);
  }

  return found;
}
