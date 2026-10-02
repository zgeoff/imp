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
  path: z.string().optional(),
  port: z.int().positive().optional(),
  listener: z.string(),
});

const ConnectionSchema = z.object({ id: z.int().positive() });

// the agent makes a directory and a socket, or starts a helper, then answers
const ANSWER_TIMEOUT_MS = 10_000;

// What a guest listener serves: the ssh-agent socket for SSH_AUTH_SOCK, or a
// reverse forward's unix socket (at a path, or one the agent makes for a
// null path) or port on the guest's 127.0.0.1 (0 takes any free port).
export type ListenSpec =
  | { readonly network: 'ssh-agent' }
  | { readonly network: 'unix'; readonly path: string | null }
  | { readonly network: 'tcp'; readonly port: number };

// A socket in the guest whose clients come back to impd (protocol
// `agent.listen` and `listen`). It lives until close, or until the agent
// connection ends: a forced sleep resets it.
export interface GuestListener {
  // the unix socket, or null for a port
  readonly path: string | null;

  // the port, or null for a unix socket
  readonly port: number | null;
  readonly id: string;

  // the id of each client that waits for an agent.accept; ends with the
  // listener
  readonly connections: () => AsyncGenerator<number, void, undefined>;
  readonly close: () => void;
}

function buildListenRequest(spec: ListenSpec): Readonly<Record<string, string>> {
  if (spec.network === 'ssh-agent') {
    return { op: 'agent.listen' };
  }

  if (spec.network === 'unix') {
    return { op: 'listen', network: 'unix', address: spec.path ?? '' };
  }

  return { op: 'listen', network: 'tcp', address: `127.0.0.1:${String(spec.port)}` };
}

// Throws AGENT_OUTDATED for an agent from before the op.
export async function openListener(vsockPath: string, spec: ListenSpec): Promise<GuestListener> {
  const feature = spec.network === 'ssh-agent' ? 'agent-forwarding' : 'reverse-forward';

  const connection = await openAgentConnection(vsockPath);

  try {
    connection.sendJson(FRAME_TYPES.request, buildListenRequest(spec));

    const answer = await readFrameWithin(connection, ANSWER_TIMEOUT_MS);

    if (answer?.type !== FRAME_TYPES.response) {
      throw new Error('agent closed the listen connection before it answered');
    }

    requireNoAgentError(answer);

    const listening = ListenResponseSchema.parse(decodeJsonPayload(answer));

    return {
      path: listening.path ?? null,
      port: listening.port ?? null,
      id: listening.listener,
      connections: () => readConnections(connection),
      close: connection.close,
    };
  } catch (error) {
    connection.close();

    return handleUnknownOp(feature)(error);
  }
}

// The relay for one client of a listener (protocol `agent.accept`). Closing
// it at once refuses the client.
export function openAccept(
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
