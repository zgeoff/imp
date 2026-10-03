import type { AgentSession } from '../agent-client/agent-requests';
import type { ExecStream } from '../agent-client/exec-stream';
import { isBrokerSession, writeBrokerSession } from '../db/broker-sessions';
import type { ImpDatabase } from '../db/open-database';
import { buildBrokerNotReadyError } from './exec-require';

// A start that requires the broker and names a session passes to a session
// that runs only when that session's run started with the requirement
// (db/broker-sessions.ts).

// Before the open, from the agent's session list: a refusal here never
// reaches the agent, so the session's viewer keeps it.
export function checkBrokerAttach(
  db: ImpDatabase,
  impId: string,
  name: string,
  sessions: readonly AgentSession[],
): Promise<Error | null> {
  const running = sessions.find((session) => session.name === name && session.state === 'running');

  if (running === undefined) {
    return Promise.resolve(null);
  }

  return isCovered(db, impId, running.execution_generation, name);
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
    const running = sessions
      .filter((session) => session.state === 'running')
      .flatMap((session) => session.execution_generation ?? []);

    await writeBrokerSession(db, impId, generation, running);
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
