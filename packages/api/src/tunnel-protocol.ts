import * as z from 'zod';
import { NameSchema } from './name-schema';

// `/tunnel` WebSocket for `imp proxy`, one per TCP connection, bearer auth only.
// The client sends `open` and waits for `opened`; binary messages then carry
// the bytes, and `eof` is a TCP half-close from that side.

// A reverse forward holds a control socket: `listen` answers `listening`,
// then a `connection` per guest client, which the client takes with `accept`
// on a socket of its own, as an `open`. It ends with the control socket.

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

// a unix socket at a path, or one the agent makes for a null path, or a
// port on the guest's 127.0.0.1, where 0 takes any free port
const TunnelListenSchema = z
  .object({
    type: z.literal('listen'),
    name: NameSchema,
    network: z.enum(['unix', 'tcp']),
    path: z.string().startsWith('/').nullable().optional(),
    port: z.int().min(0).max(65_535).optional(),
  })
  .refine(
    (listen) =>
      listen.network === 'tcp'
        ? listen.port !== undefined && listen.path === undefined
        : listen.port === undefined,
    { message: 'tcp takes a port, unix a path or null', path: ['network'] },
  );

export const TunnelClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open'),
    name: NameSchema,
    port: z.int().min(1).max(65_535),
  }),
  z.object({ type: z.literal('eof') }),
  AckSchema,
  TunnelListenSchema,
  z.object({
    type: z.literal('accept'),
    name: NameSchema,
    listener: z.string().min(1),
    connection: z.int().positive(),
  }),
]);

export type TunnelClientMessage = z.infer<typeof TunnelClientMessageSchema>;

export const TunnelServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('opened') }),
  z.object({ type: z.literal('eof') }),
  AckSchema,

  // where a reverse forward listens in the guest: a path or a port
  z.object({
    type: z.literal('listening'),
    listener: z.string(),
    path: z.string().nullable(),
    port: z.int().nullable(),
  }),

  // a client in the guest waits for an accept
  z.object({ type: z.literal('connection'), id: z.int().positive() }),

  // code is a contract error (NOT_FOUND, …), TUNNEL_LIMIT, or an agent error
  // (DIAL_FAILED, LISTEN_FAILED, AGENT_OUTDATED); the socket closes after it
  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
  }),
]);

export type TunnelServerMessage = z.infer<typeof TunnelServerMessageSchema>;
