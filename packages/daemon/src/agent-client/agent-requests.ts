import * as z from 'zod';
import { AgentError, openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { FRAME_TYPES, decodeJsonPayload } from './frame-codec';
import type { AgentFrame } from './frame-codec';

const AgentErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const PingResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptime_ms: z.number(),
});

const OkResponseSchema = z.object({ ok: z.literal(true) });

export type AgentPing = z.infer<typeof PingResponseSchema>;

// throws AgentError when the frame is a RESPONSE carrying an `error`
export function requireNoAgentError(frame: AgentFrame): void {
  if (frame.type !== FRAME_TYPES.response) {
    return;
  }

  const parsed = AgentErrorResponseSchema.safeParse(decodeJsonPayload(frame));

  if (parsed.success) {
    throw new AgentError(parsed.data.error.code, parsed.data.error.message);
  }
}

// One unary request: REQUEST out, one RESPONSE back, then the agent closes.
async function sendAgentRequest(
  vsockPath: string,
  request: Readonly<Record<string, unknown>>,
  timeoutMs = 5000,
): Promise<unknown> {
  const connection = await openAgentConnection(vsockPath, timeoutMs);

  try {
    connection.sendJson(FRAME_TYPES.request, request);

    const frame = await readFrameWithin(connection, timeoutMs);

    if (frame?.type !== FRAME_TYPES.response) {
      throw new Error(`agent ${String(request['op'])}: no response`);
    }

    requireNoAgentError(frame);

    return decodeJsonPayload(frame);
  } finally {
    connection.close();
  }
}

export async function sendPing(vsockPath: string, timeoutMs = 2000): Promise<AgentPing> {
  const response = await sendAgentRequest(vsockPath, { op: 'ping' }, timeoutMs);

  return PingResponseSchema.parse(response);
}

// The agent replies, then powers the guest off; Firecracker exits after.
export async function sendShutdown(vsockPath: string): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'shutdown' });

  OkResponseSchema.parse(response);
}

// sync + FIFREEZE on the guest root; the agent thaws by itself after
// `timeoutMs` if no thaw arrives. The answer can take a while: sync flushes
// the guest page cache first.
export async function sendFreeze(vsockPath: string, timeoutMs: number): Promise<void> {
  const response = await sendAgentRequest(
    vsockPath,
    { op: 'freeze', timeout_ms: timeoutMs },
    timeoutMs,
  );

  OkResponseSchema.parse(response);
}

export async function sendThaw(vsockPath: string): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'thaw' });

  OkResponseSchema.parse(response);
}

async function readFrameWithin(
  connection: AgentConnection,
  timeoutMs: number,
): Promise<AgentFrame | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`agent did not answer within ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([connection.next(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
