import type { AgentSession } from '../agent-client/agent-requests';
import type { ExecStream } from '../agent-client/exec-stream';
import { isBrokerSession, writeBrokerSession } from '../db/broker-sessions';
import type { ImpDatabase } from '../db/open-database';
import { buildBrokerNotReadyError } from './exec-require';

// A start that requires the broker and names a session passes to a session
// that runs only when that session's run started with the requirement
// (db/broker-sessions.ts).

// Before the open: each run the start would attach to (the running one, an
// exited one its resumeFrom names) must have started with the requirement.
// Refused here, the agent never sees it: viewer and output stay as they are.
export async function checkBrokerAttach(
  db: ImpDatabase,
  impId: string,
  name: string,
  resumeGeneration: string | undefined,
  sessions: readonly AgentSession[],
): Promise<Error | null> {
  const attached = sessions.filter(
    (session) =>
      session.name === name &&
      (session.state === 'running' ||
        (resumeGeneration !== undefined && session.execution_generation === resumeGeneration)),
  );

  for (const session of attached) {
    const refused = await isCovered(db, impId, session.execution_generation, name);

    if (refused !== null) {
      return refused;
    }
  }

  return null;
}

// After the open: records a session the start created; an attach to one
// that started between the list and the open is refused here instead.
export async function checkOpenedSession(
  db: ImpDatabase,
  impId: string,
  name: string,
  stream: Pick<ExecStream, 'created' | 'output'>,
  sessions: readonly AgentSession[],
): Promise<Error | null> {
  const output = stream.output;
  const generation = output?.continuity === 'offsets' ? output.executionGeneration : undefined;

  if (!stream.created) {
    return isCovered(db, impId, generation, name);
  }

  // an agent from before output offsets names no generation: its sessions
  // never pass an attach that requires the broker
  if (generation !== undefined) {
    // an exited run stays listed while a resume can still attach to it
    const listed = sessions.flatMap((session) => session.execution_generation ?? []);

    await writeBrokerSession(db, impId, generation, listed);
  }

  return null;
}

async function isCovered(
  db: ImpDatabase,
  impId: string,
  generation: string | undefined,
  name: string,
): Promise<Error | null> {
  const isRecorded =
    generation === undefined ? false : await isBrokerSession(db, impId, generation);

  return isRecorded
    ? null
    : buildBrokerNotReadyError(`session ${name} was started without the broker requirement`);
}
