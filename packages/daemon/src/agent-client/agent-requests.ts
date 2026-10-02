import * as z from 'zod';
import { AgentError, openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { handleUnknownOp } from './agent-outdated';
import { FRAME_TYPES, decodeJsonPayload } from './frame-codec';
import type { AgentFrame } from './frame-codec';

const AgentErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const PingResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),

  // an agent that cannot read its clock leaves it out
  uptime_ms: z.number().optional(),
});

export const OkResponseSchema = z.object({ ok: z.literal(true) });

// the agent's own 10 s wait for the new size, and the resize after it
const GROW_TIMEOUT_MS = 20_000;

export const AgentExitSchema = z.object({ code: z.int(), signal: z.int() }).readonly();

export const AgentSessionSchema = z
  .object({
    name: z.string(),
    pid: z.int(),
    argv: z.array(z.string()).readonly(),
    state: z.enum(['running', 'exited']),
    attached: z.boolean(),
    cols: z.int(),
    rows: z.int(),
    started_unix_ms: z.int(),
    exit: AgentExitSchema.optional(),
  })
  .readonly();

const ActivityResponseSchema = z.object({
  tcp_established: z.int().nonnegative(),
  exec_sessions: z.int().nonnegative(),
  load1: z.number(),

  // an agent from before sessions leaves it out
  sessions: z.array(AgentSessionSchema).readonly().default([]),
});

export type AgentPing = z.infer<typeof PingResponseSchema>;

export type AgentActivity = z.infer<typeof ActivityResponseSchema>;

export type AgentSession = z.infer<typeof AgentSessionSchema>;

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
export async function sendAgentRequest(
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

export async function sendActivity(vsockPath: string, timeoutMs = 1000): Promise<AgentActivity> {
  const response = await sendAgentRequest(vsockPath, { op: 'activity' }, timeoutMs);

  return ActivityResponseSchema.parse(response);
}

// Throws AgentError NO_SESSION when the imp has no session of that name,
// and AGENT_OUTDATED for an agent from before sessions.
export async function sendSessionKill(vsockPath: string, session: string): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'session.kill', session }).catch(
    handleUnknownOp('sessions'),
  );

  OkResponseSchema.parse(response);
}

// After a wake: the guest clock stopped while the VM slept.
export async function sendResumed(vsockPath: string, unixMs: number): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'resumed', unix_ms: unixMs });

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

// After the host grew the disk: the agent waits up to 10 s for the guest to
// see the new size, then grows the root filesystem online. AGENT_OUTDATED
// for an agent from before it: the next cold boot grows the filesystem.
export async function sendGrow(vsockPath: string, diskBytes: number): Promise<void> {
  const response = await sendAgentRequest(
    vsockPath,
    { op: 'grow', disk_bytes: diskBytes },
    GROW_TIMEOUT_MS,
  ).catch(handleUnknownOp('grow'));

  OkResponseSchema.parse(response);
}

export async function sendThaw(vsockPath: string): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'thaw' });

  OkResponseSchema.parse(response);
}

// the next frame, or a rejection after `timeoutMs`
export async function readFrameWithin(
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
