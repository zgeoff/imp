import type { MessageInitShape } from '@bufbuild/protobuf';
import { openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { handleUnknownOp } from './agent-outdated';
import { LogCursorSchema, OKSchema, ServicesListSchema } from './agent-protocol';
import type { LogCursor, ServiceDefSchema, ServicesList } from './agent-protocol';
import {
  readFrameWithin,
  requireNoAgentError,
  sendAgentRequest,
  sendRequestFrame,
} from './agent-requests';
import { decodeAgentMessage } from './decode-agent-message';
import { FRAME_TYPES, decodeJsonPayload } from './frame-codec';

// The agent's services ops (docs/architecture/protocol.md#servicesadd-servicesremove-servicesrestart). Each
// throws AgentError NO_SERVICE for a name it does not have, and
// AGENT_OUTDATED for an agent from before them.

// a stop waits up to 5 s for SIGTERM before SIGKILL, then the start
const STOP_TIMEOUT_MS = 15_000;

// how long the agent may take to send the first frame of a log stream
const LOGS_START_TIMEOUT_MS = 5000;

export async function sendServicesList(
  vsockPath: string,
  timeoutMs?: number,
): Promise<ServicesList> {
  const response = await sendAgentRequest(vsockPath, { op: 'services.list' }, timeoutMs);

  return decodeAgentMessage(ServicesListSchema, response);
}

export async function sendServicesAdd(
  vsockPath: string,
  def: MessageInitShape<typeof ServiceDefSchema>,
  replace: boolean,
): Promise<void> {
  const response = await sendAgentRequest(
    vsockPath,
    { op: 'services.add', def, ...(replace && { replace }) },
    STOP_TIMEOUT_MS,
  ).catch(handleUnknownOp('services'));

  decodeAgentMessage(OKSchema, response);
}

export async function sendServicesRemove(vsockPath: string, service: string): Promise<void> {
  const response = await sendAgentRequest(
    vsockPath,
    { op: 'services.remove', service },
    STOP_TIMEOUT_MS,
  ).catch(handleUnknownOp('services'));

  decodeAgentMessage(OKSchema, response);
}

export async function sendServicesRestart(vsockPath: string, service: string): Promise<void> {
  const response = await sendAgentRequest(
    vsockPath,
    { op: 'services.restart', service },
    STOP_TIMEOUT_MS,
  ).catch(handleUnknownOp('services'));

  decodeAgentMessage(OKSchema, response);
}

export interface ServiceLogRequest {
  readonly service: string;
  readonly lines: number;
  readonly follow: boolean;

  // everything after it, in place of `lines`
  readonly cursor?: LogCursor | undefined;
}

export type ServiceLogChunk =
  | { readonly kind: 'data'; readonly data: Uint8Array }
  | { readonly kind: 'cursor'; readonly cursor: LogCursor };

// A service's log: the chunks end when the agent sends STDOUT_EOF or closes,
// and `close` ends a follow. A cursor follows each piece of data.
export interface ServiceLogStream {
  readonly chunks: () => AsyncGenerator<ServiceLogChunk, void, undefined>;
  readonly close: () => void;
}

export async function openServiceLogStream(
  vsockPath: string,
  request: Readonly<ServiceLogRequest>,
): Promise<ServiceLogStream> {
  const connection = await openAgentConnection(vsockPath);

  try {
    sendRequestFrame(connection, {
      op: 'services.logs',
      service: request.service,
      lines: request.lines,
      follow: request.follow,
      ...(request.cursor !== undefined && { cursor: request.cursor }),
    });

    const first = await readFrameWithin(connection, LOGS_START_TIMEOUT_MS);

    if (first === null) {
      throw new Error('agent closed the log connection before it answered');
    }

    requireNoAgentError(first);
    decodeAgentMessage(OKSchema, decodeJsonPayload(first));
  } catch (error) {
    connection.close();

    return handleUnknownOp('services')(error);
  }

  return {
    chunks: () => readLogChunks(connection),
    close: connection.close,
  };
}

async function* readLogChunks(
  connection: AgentConnection,
): AsyncGenerator<ServiceLogChunk, void, undefined> {
  for (;;) {
    const frame = await connection.next();

    if (frame === null || frame.type === FRAME_TYPES.stdoutEof) {
      return;
    }

    if (frame.type === FRAME_TYPES.stdout) {
      yield { kind: 'data', data: frame.payload };
    } else if (frame.type === FRAME_TYPES.cursor) {
      yield {
        kind: 'cursor',
        cursor: decodeAgentMessage(LogCursorSchema, decodeJsonPayload(frame)),
      };
    }
  }
}
