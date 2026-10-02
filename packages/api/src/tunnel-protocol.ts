import * as z from 'zod';
import { NameSchema } from './name-schema';

// `/tunnel` WebSocket for `imp proxy`, one per TCP connection, bearer auth only.
// The client sends `open` and waits for `opened`; binary messages then carry
// the bytes, and `eof` is a TCP half-close from that side.

export const TUNNEL_PATH = '/tunnel';

// Close codes: both eofs seen; a message that breaks this protocol; impd
// stopping; the connection in the guest ended without its eof (a reset, a
// forced sleep), after which the next connection wakes the imp again.
export const TUNNEL_CLOSE_NORMAL = 1000;
export const TUNNEL_CLOSE_PROTOCOL = 1002;
export const TUNNEL_CLOSE_RESTARTING = 1012;
export const TUNNEL_CLOSE_LOST = 4000;

// Each side acks the bytes it delivered onward, and a sender keeps at most
// this many unacked: a WebSocket cannot pause reads, so a slow reader would
// otherwise grow the other side's memory.
export const TUNNEL_WINDOW_BYTES = 1_048_576;

// the largest binary message the client sends: it may pass the window by one
export const TUNNEL_MAX_FRAME_BYTES = 65_536;
const AckSchema = z.object({ type: z.literal('ack'), bytes: z.int().positive() });

export const TunnelClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open'),
    name: NameSchema,
    port: z.int().min(1).max(65_535),
  }),
  z.object({ type: z.literal('eof') }),
  AckSchema,
]);

export type TunnelClientMessage = z.infer<typeof TunnelClientMessageSchema>;

export const TunnelServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('opened') }),
  z.object({ type: z.literal('eof') }),
  AckSchema,

  // code is a contract error (NOT_FOUND, …), TUNNEL_LIMIT, or an agent error
  // (DIAL_FAILED, AGENT_OUTDATED); the socket closes after it
  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
  }),
]);

export type TunnelServerMessage = z.infer<typeof TunnelServerMessageSchema>;
