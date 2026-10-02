import * as z from 'zod';

// JSON-RPC 2.0 as MCP uses it: one message per line on stdio. MCP dropped
// batches in 2025-06-18, so an array is an invalid request.

export type RequestId = string | number;

export const PARSE_ERROR = -32_700;
export const INVALID_REQUEST = -32_600;
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_PARAMS = -32_602;
export const INTERNAL_ERROR = -32_603;
const IdSchema = z.union([z.string(), z.int()]);
const ParamsSchema = z.record(z.string(), z.unknown());

const MessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  id: IdSchema.optional(),
  params: ParamsSchema.optional(),
});

export type IncomingMessage =
  | {
      readonly kind: 'request';
      readonly id: RequestId;
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'notification';
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'response' }
  | { readonly kind: 'invalid'; readonly code: number; readonly message: string };

export function parseMessage(line: string): IncomingMessage {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'invalid', code: PARSE_ERROR, message: 'parse error: not JSON' };
  }

  const message = MessageSchema.safeParse(parsed);

  if (!message.success) {
    return isResponse(parsed)
      ? { kind: 'response' }
      : { kind: 'invalid', code: INVALID_REQUEST, message: 'invalid request' };
  }

  const params = message.data.params ?? {};

  return message.data.id === undefined
    ? { kind: 'notification', method: message.data.method, params }
    : { kind: 'request', id: message.data.id, method: message.data.method, params };
}

// a response from the client, to a request this server never sends
function isResponse(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return 'id' in value && ('result' in value || 'error' in value);
}

export function formatResult(id: RequestId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export function formatError(id: RequestId | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

export function formatNotification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}
