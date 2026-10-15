import * as z from 'zod';
import { runImp } from './imp-cli';

const SessionRowSchema = z.object({
  name: z.string(),
  pid: z.number(),
  state: z.string(),
  attached: z.boolean(),
  cols: z.number(),
  rows: z.number(),
});

export type SessionRow = z.infer<typeof SessionRowSchema>;

// `impz sessions <imp> --json`, with the fields the suites read
export function parseSessions(stdout: string): SessionRow[] {
  return z.array(SessionRowSchema).parse(JSON.parse(stdout));
}

export async function listSessions(imp: string): Promise<SessionRow[]> {
  const stdout = await runImp('sessions', imp, '--json');

  return parseSessions(stdout);
}

// the session named `session` in the imp; throws when it has none
export async function requireSession(imp: string, session: string): Promise<SessionRow> {
  const sessions = await listSessions(imp);

  const found = sessions.find((row) => row.name === session);

  if (found === undefined) {
    throw new Error(`no session ${session} in ${imp}: ${JSON.stringify(sessions)}`);
  }

  return found;
}
