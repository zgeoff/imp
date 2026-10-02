import * as z from 'zod';
import { openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { handleUnknownOp } from './agent-outdated';
import { readFrameWithin, requireNoAgentError } from './agent-requests';
import { openRelayStream } from './dial-stream';
import type { DialStream } from './dial-stream';
import { FRAME_TYPES, decodeJsonPayload } from './frame-codec';

const ListenResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
  listener: z.string(),
});

const ConnectionSchema = z.object({ id: z.int().positive() });

// the agent makes a directory and a socket, then answers
const ANSWER_TIMEOUT_MS = 5000;

// An ssh-agent socket in the guest (protocol `agent.listen`). It lives until
// close, or until the agent connection ends: a forced sleep resets it.
export interface AgentListener {
  // for SSH_AUTH_SOCK
  readonly path: string;
  readonly id: string;

  // the id of each client that waits for an agent.accept; ends with the
  // listener
  readonly connections: () => AsyncGenerator<number, void, undefined>;
  readonly close: () => void;
}

// Throws AGENT_OUTDATED for an agent from before agent forwarding.
export async function openAgentListener(vsockPath: string): Promise<AgentListener> {
  const connection = await openAgentConnection(vsockPath);

  try {
    connection.sendJson(FRAME_TYPES.request, { op: 'agent.listen' });

    const answer = await readFrameWithin(connection, ANSWER_TIMEOUT_MS);

    if (answer?.type !== FRAME_TYPES.response) {
      throw new Error('agent closed the agent.listen connection before it answered');
    }

    requireNoAgentError(answer);

    const listening = ListenResponseSchema.parse(decodeJsonPayload(answer));

    return {
      path: listening.path,
      id: listening.listener,
      connections: () => readConnections(connection),
      close: connection.close,
    };
  } catch (error) {
    connection.close();

    return handleUnknownOp('agent-forwarding')(error);
  }
}

// The relay for one client of a listener (protocol `agent.accept`). Closing
// it at once refuses the client.
export function openAgentAccept(
  vsockPath: string,
  listener: string,
  connection: number,
): Promise<DialStream> {
  return openRelayStream(
    vsockPath,
    { op: 'agent.accept', listener, connection },
    'agent-forwarding',
    ANSWER_TIMEOUT_MS,
  );
}

async function* readConnections(
  connection: AgentConnection,
): AsyncGenerator<number, void, undefined> {
  for (;;) {
    const frame = await connection.next();

    if (frame === null) {
      return;
    }

    if (frame.type === FRAME_TYPES.connection) {
      yield ConnectionSchema.parse(decodeJsonPayload(frame)).id;
    }
  }
}
