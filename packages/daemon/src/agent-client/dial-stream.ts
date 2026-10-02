import { openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { handleUnknownOp } from './agent-outdated';
import type { AgentFeature } from './agent-outdated';
import { readFrameWithin, requireNoAgentError } from './agent-requests';
import { FRAME_TYPES } from './frame-codec';

// an address inside the guest: "host:port" for tcp, a socket path for unix
export interface DialTarget {
  readonly network: 'tcp' | 'unix';
  readonly address: string;
}

export type DialEvent =
  | { readonly type: 'data'; readonly data: Uint8Array }

  // the target closed its side; no data follows
  | { readonly type: 'eof' };

export interface DialStream {
  readonly write: (data: Uint8Array) => void;

  // resolves once what was written is on its way to the guest
  readonly drained: () => Promise<void>;

  // closes the target's write side (a TCP half-close)
  readonly end: () => void;

  // the target's bytes, then one eof; ends without an eof when the target
  // or the connection failed
  readonly events: () => AsyncGenerator<DialEvent, void, undefined>;
  readonly close: () => void;
}

// longer than the agent's own 5 s connect timeout, so its DIAL_FAILED arrives
const DIAL_ANSWER_TIMEOUT_MS = 10_000;

// Connects to an address in the guest through the agent (protocol `dial`).
// Throws AgentError DIAL_FAILED when the agent cannot connect, and
// AGENT_OUTDATED for an agent from before dial.
export function openDialStream(
  vsockPath: string,
  target: Readonly<DialTarget>,
  answerTimeoutMs = DIAL_ANSWER_TIMEOUT_MS,
): Promise<DialStream> {
  return openRelayStream(vsockPath, { op: 'dial', ...target }, 'ssh', answerTimeoutMs);
}

// One request whose RESPONSE starts a relay with dial's framing; dial and
// agent.accept both use it.
export async function openRelayStream(
  vsockPath: string,
  request: Readonly<Record<string, unknown>>,
  feature: AgentFeature,
  answerTimeoutMs: number,
): Promise<DialStream> {
  const connection = await openAgentConnection(vsockPath);

  try {
    connection.sendJson(FRAME_TYPES.request, request);

    const answer = await readFrameWithin(connection, answerTimeoutMs);

    if (answer?.type !== FRAME_TYPES.response) {
      throw new Error(`agent closed the ${String(request['op'])} connection before it answered`);
    }

    requireNoAgentError(answer);
  } catch (error) {
    connection.close();

    return handleUnknownOp(feature)(error);
  }

  return {
    write: (data) => {
      connection.send(FRAME_TYPES.stdin, data);
    },
    drained: connection.drained,
    end: () => {
      connection.send(FRAME_TYPES.stdinEof);
    },
    events: () => readDialEvents(connection),
    close: connection.close,
  };
}

async function* readDialEvents(
  connection: AgentConnection,
): AsyncGenerator<DialEvent, void, undefined> {
  for (;;) {
    const frame = await connection.next();

    if (frame === null) {
      return;
    }

    if (frame.type === FRAME_TYPES.stdout) {
      yield { type: 'data', data: frame.payload };
    } else if (frame.type === FRAME_TYPES.stdoutEof) {
      yield { type: 'eof' };
    }
  }
}
