import type { JsonObject, JsonValue, MessageInitShape } from '@bufbuild/protobuf';
import { requireWithin } from '../process/require-within';
import { AgentError, openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { handleUnknownOp } from './agent-outdated';
import { ErrorResponseSchema, OKSchema, PingSchema, RequestSchema } from './agent-protocol';
import type { Activity, ErrorResponse, Ping } from './agent-protocol';
import { decodeAgentMessage } from './decode-agent-message';
import { encodeAgentMessage } from './encode-agent-message';
import { FRAME_TYPES, decodeJsonPayload } from './frame-codec';
import type { AgentFrame } from './frame-codec';
import { parseAgentActivity } from './parse-agent-activity';

// a claim flushes the disk and reseeds the CRNG: well under a second
const CLAIM_TIMEOUT_MS = 5000;

// the agent's own 10 s wait for the new size, and the resize after it
const GROW_TIMEOUT_MS = 20_000;

// A REQUEST frame's message: every request names its op.
export type AgentRequest = MessageInitShape<typeof RequestSchema> & { readonly op: string };

// throws AgentError when the frame is a RESPONSE carrying an `error`
export function requireNoAgentError(frame: AgentFrame): void {
  if (frame.type !== FRAME_TYPES.response) {
    return;
  }

  const payload = decodeJsonPayload(frame);

  if (!isJsonObject(payload) || !('error' in payload)) {
    return;
  }

  const error = decodeErrorResponse(payload).error;

  if (error !== undefined) {
    throw new AgentError(error.code, error.message, error.data);
  }
}

// An error whose data impd cannot read keeps its code and message without
// the data, so the caller still sees the agent's error.
function decodeErrorResponse(payload: JsonObject): ErrorResponse {
  try {
    return decodeAgentMessage(ErrorResponseSchema, payload);
  } catch {
    const error = payload['error'];
    const bare = isJsonObject(error) ? { ...error, data: null } : error;

    return decodeAgentMessage(ErrorResponseSchema, { ...payload, error: bare ?? null });
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// sends the REQUEST frame that opens every connection
export function sendRequestFrame(connection: AgentConnection, request: AgentRequest): void {
  connection.sendJson(FRAME_TYPES.request, encodeAgentMessage(RequestSchema, request));
}

// One unary request: REQUEST out, one RESPONSE back, then the agent closes.
export async function sendAgentRequest(
  vsockPath: string,
  request: AgentRequest,
  timeoutMs = 5000,
): Promise<JsonValue> {
  const connection = await openAgentConnection(vsockPath, timeoutMs);

  try {
    sendRequestFrame(connection, request);

    const frame = await readFrameWithin(connection, timeoutMs);

    if (frame?.type !== FRAME_TYPES.response) {
      throw new Error(`agent ${request.op}: no response`);
    }

    requireNoAgentError(frame);

    return decodeJsonPayload(frame);
  } finally {
    connection.close();
  }
}

export async function sendPing(vsockPath: string, timeoutMs = 2000): Promise<Ping> {
  const response = await sendAgentRequest(vsockPath, { op: 'ping' }, timeoutMs);

  return decodeAgentMessage(PingSchema, response);
}

// What a guest restored from a boot template needs to become one imp
// (docs/architecture/boot-templates.md#claim).
export interface Claim {
  readonly id: string;
  readonly hostname: string;
  readonly ip: string;
  readonly gw: string;

  // the guest's IPv6 /128 and gateway; null when the host gives imps none
  readonly ip6: string | null;
  readonly gw6: string | null;
  readonly dns: readonly string[];
  readonly mac: string;

  // the disk's size as the host made it: the parked agent waits to see it
  readonly diskBytes: number;
  readonly unixMs: number;
  readonly seed: Uint8Array;
  readonly isIdentityReset: boolean;
}

export async function sendClaim(vsockPath: string, claim: Readonly<Claim>): Promise<void> {
  const response = await sendAgentRequest(
    vsockPath,
    {
      op: 'claim',
      claim: {
        id: claim.id,
        hostname: claim.hostname,
        ip: claim.ip,
        gw: claim.gw,
        ...(claim.ip6 !== null && { ip6: claim.ip6 }),
        ...(claim.gw6 !== null && { gw6: claim.gw6 }),
        dns: [...claim.dns],
        mac: claim.mac,
        diskBytes: claim.diskBytes,
        unixMs: claim.unixMs,
        seed: claim.seed,
        resetIdentity: claim.isIdentityReset,
      },
    },
    CLAIM_TIMEOUT_MS,
  );

  decodeAgentMessage(OKSchema, response);
}

// The agent replies, then powers the guest off; Firecracker exits after.
export async function sendShutdown(vsockPath: string): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'shutdown' });

  decodeAgentMessage(OKSchema, response);
}

export async function sendActivity(vsockPath: string, timeoutMs = 1000): Promise<Activity> {
  const response = await sendAgentRequest(vsockPath, { op: 'activity' }, timeoutMs);

  return parseAgentActivity(response);
}

// Throws AgentError NO_SESSION when the imp has no session of that name,
// and AGENT_OUTDATED for an agent from before sessions.
export async function sendSessionKill(vsockPath: string, session: string): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'session.kill', session }).catch(
    handleUnknownOp('sessions'),
  );

  decodeAgentMessage(OKSchema, response);
}

// After a wake: the guest clock stopped while the VM slept.
export async function sendResumed(vsockPath: string, unixMs: number): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'resumed', unixMs });

  decodeAgentMessage(OKSchema, response);
}

// sync + FIFREEZE on the guest root; the agent thaws by itself after
// `timeoutMs` if no thaw arrives. The answer can take a while: sync flushes
// the guest page cache first.
export async function sendFreeze(vsockPath: string, timeoutMs: number): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'freeze', timeoutMs }, timeoutMs);

  decodeAgentMessage(OKSchema, response);
}

// After the host grew the disk: the agent waits up to 10 s for the guest to
// see the new size, then grows the root filesystem online. AGENT_OUTDATED
// for an agent from before it: the next cold boot grows the filesystem.
export async function sendGrow(vsockPath: string, diskBytes: number): Promise<void> {
  const response = await sendAgentRequest(
    vsockPath,
    { op: 'grow', diskBytes },
    GROW_TIMEOUT_MS,
  ).catch(handleUnknownOp('grow'));

  decodeAgentMessage(OKSchema, response);
}

export async function sendThaw(vsockPath: string): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'thaw' });

  decodeAgentMessage(OKSchema, response);
}

// the next frame, or a rejection after `timeoutMs`
export function readFrameWithin(
  connection: AgentConnection,
  timeoutMs: number,
): Promise<AgentFrame | null> {
  return requireWithin(
    connection.next(),
    timeoutMs,
    () => new Error(`agent did not answer within ${String(timeoutMs)} ms`),
  );
}
