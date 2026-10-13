import * as z from 'zod';
import { AgentBootIdSchema, AgentGenerationSchema, AgentSessionNameSchema } from './agent-ids';

// The agent protocol's payloads, both ways; the fixtures in
// agent/internal/contract hold them to the Go side
// (docs/architecture/guest/protocol.md#contract-tests).

// the agent's error codes (agent/internal/proto/messages.go)
export const AGENT_ERROR_CODES = [
  'BAD_REQUEST',
  'DIAL_FAILED',
  'EXEC_FAILED',
  'FROZEN',

  // the inner container, where every process runs, is down
  'INNER_DOWN',
  'INTERNAL',

  // a resume named an offset past the end of the generation it names
  'INVALID_RESUME',
  'LISTEN_FAILED',
  'NO_CONNECTION',
  'NO_SERVICE',
  'NO_SESSION',
  'POWERING_OFF',
  'SERVICE_EXISTS',
  'SESSION_LIMIT',
  'UNKNOWN_OP',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

// the code stays a string: an agent newer than this impd, as on an imp
// that moved here, may send one this list lacks
export const AgentErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), data: z.unknown().optional() }),
});

const OffsetSchema = z.int().nonnegative();

export const AgentExitSchema = z.object({ code: z.int(), signal: z.int() }).readonly();

export const AgentPreviousSchema = z.object({
  execution_generation: AgentGenerationSchema,
  end: OffsetSchema,
  exit: AgentExitSchema,
});

// the data of NO_SESSION: this boot, and the generation that last ran under
// the name in it
export const NoSessionDataSchema = z.object({
  boot_id: AgentBootIdSchema,
  previous: AgentPreviousSchema.optional(),
});

// the data of INVALID_RESUME
export const InvalidResumeDataSchema = z.object({ end: OffsetSchema, buffer_start: OffsetSchema });

// the inner container: whether it runs, how often it started again after its
// init died, and why the last start failed
export const AgentInnerSchema = z.object({
  up: z.boolean(),
  restarts: z.int().nonnegative(),
  last_error: z.string().optional(),
});

export const PingResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),

  // an agent that cannot read its clock leaves it out
  uptime_ms: z.number().optional(),

  // set on a boot that asked for an identity reset (docs/guides/templates.md#identity)
  identity_reset: z.enum(['ok', 'failed']).optional(),

  // an agent parked in a boot template, waiting for its claim
  stage: z.literal('template').optional(),

  // an agent from before 0.14.0 leaves it out
  inner: AgentInnerSchema.optional(),

  // the guest's boot_id; an agent from before output offsets leaves it out
  boot_id: z.string().optional(),
});

export type AgentPing = z.infer<typeof PingResponseSchema>;

export type AgentInner = z.infer<typeof AgentInnerSchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });

// a session as the agent lists it; impd adds when it saw the list
export const AgentSessionObjectSchema = z.object({
  name: AgentSessionNameSchema,
  pid: z.int(),
  argv: z.array(z.string()).readonly(),
  state: z.enum(['running', 'exited']),
  attached: z.boolean(),
  cols: z.int(),
  rows: z.int(),
  started_unix_ms: z.int(),
  exit: AgentExitSchema.optional(),

  // an agent from before output offsets leaves these out
  execution_generation: AgentGenerationSchema.optional(),
  boot_id: AgentBootIdSchema.optional(),
  end: z.int().nonnegative().optional(),

  // a session started with log, which impd taps; left out by an agent from
  // before session logs, and for other sessions
  log: z.boolean().optional(),
});

const AgentSessionSchema = AgentSessionObjectSchema.readonly();

export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const ActivityResponseSchema = z.object({
  tcp_established: z.int().nonnegative(),
  exec_sessions: z.int().nonnegative(),
  load1: z.number(),

  // an agent from before sessions leaves it out. A session that does not
  // parse is dropped, not the whole answer, which the watchdog reads as a
  // sign of life.
  sessions: z
    .array(z.unknown())
    .default([])
    .transform((list): readonly AgentSession[] => list.flatMap((entry) => readAgentSession(entry))),
});

export type AgentActivity = z.infer<typeof ActivityResponseSchema>;

export const AgentResumeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact') }),
  z.object({ kind: z.literal('gap'), from: OffsetSchema, to: OffsetSchema }),
  z.object({
    kind: z.literal('generation_changed'),
    execution_generation: AgentGenerationSchema,
    first_offset: OffsetSchema,
  }),
]);

export const AgentOutputSchema = z.object({
  boot_id: AgentBootIdSchema,
  execution_generation: AgentGenerationSchema,
  buffer_start: OffsetSchema,
  end: OffsetSchema,
  offset: OffsetSchema,
  prelude: OffsetSchema,
  previous: AgentPreviousSchema.optional(),
  resume: AgentResumeSchema.optional(),

  // set for a session started with log, by an agent with session logs
  log: z.boolean().optional(),
});

export const StartedSchema = z.object({
  pid: z.int(),
  session: AgentSessionNameSchema.optional(),
  created: z.boolean().optional(),
  kill_grace_ms: z.int().optional(),

  // an agent from before output offsets leaves it out
  output: AgentOutputSchema.optional(),
});

export type AgentStarted = z.infer<typeof StartedSchema>;

export const DetachedSchema = z.object({ reason: z.string() });

// the agent.listen and listen answer: the socket or the port, which a
// request for port 0 learns here
export const ListenResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string().optional(),
  port: z.int().positive().optional(),
  listener: z.string(),
});

// a client of a listener waits for an agent.accept with this id
export const ConnectionSchema = z.object({ id: z.int().positive() });

// one services.d file; the agent sets `source`, which impd never sends
const AgentServiceDefObjectSchema = z.object({
  name: z.string().optional(),
  argv: z.array(z.string()).readonly(),
  env: z.array(z.string()).readonly().optional(),
  cwd: z.string().optional(),
  user: z.string().optional(),
  restart: z.enum(['always', 'on-failure', 'never']).optional(),
  source: z.enum(['image', 'api']).optional(),
});

export const AgentServiceDefSchema = AgentServiceDefObjectSchema.readonly();

export type AgentServiceDef = z.infer<typeof AgentServiceDefSchema>;

export const AgentServiceSchema = z
  .object({
    name: z.string(),
    state: z.enum(['starting', 'running', 'backoff', 'stopped', 'exited']),
    pid: z.int().optional(),
    restarts: z.int().nonnegative(),
    last_exit: AgentExitSchema.optional(),

    // an agent from before the services API leaves these out
    def: AgentServiceDefSchema.optional(),
    root: z.boolean().optional(),
  })
  .readonly();

export type AgentService = z.infer<typeof AgentServiceSchema>;

export const ServicesListSchema = z.object({
  services: z.array(AgentServiceSchema).readonly(),
  image_user: z.string().optional(),
});

export type AgentServices = z.infer<typeof ServicesListSchema>;

// a place in a service's log: the file, by inode, and the offset after the
// last byte sent; the CURSOR frame, and a services.logs request
export const LogCursorSchema = z.object({
  inode: z.int().nonnegative(),
  offset: z.int().nonnegative(),
});

export type LogCursor = z.infer<typeof LogCursorSchema>;

// with a session: the output after this byte, not a replay
const AgentResumeFromSchema = z.object({
  execution_generation: AgentGenerationSchema,
  offset: OffsetSchema,
});

// what a guest restored from a boot template needs to become one imp; the
// seed is base64
const AgentClaimSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  ip: z.string(),
  gw: z.string(),
  ip6: z.string().optional(),
  gw6: z.string().optional(),
  dns: z.array(z.string()).readonly(),
  mac: z.string(),
  disk_bytes: z.int().nonnegative(),
  unix_ms: z.int(),
  seed: z.base64(),
  reset_identity: z.boolean(),
});

// The REQUEST frame, one schema per op. impd builds each with these types,
// and agent-protocol.test.ts checks the fixtures the agent decodes.
export const AgentRequestSchemas = {
  bare: z.object({
    op: z.literal(['ping', 'shutdown', 'activity', 'thaw', 'services.list', 'agent.listen']),
  }),
  freeze: z.object({ op: z.literal('freeze'), timeout_ms: z.int().positive() }),
  resumed: z.object({ op: z.literal('resumed'), unix_ms: z.int() }),
  grow: z.object({ op: z.literal('grow'), disk_bytes: z.int().positive() }),
  sessionKill: z.object({ op: z.literal('session.kill'), session: z.string() }),
  service: z.object({
    op: z.literal(['services.remove', 'services.restart']),
    service: z.string(),
  }),
  exec: z.object({
    op: z.literal(['exec', 'exec.outer']),
    argv: z.array(z.string()).readonly(),
    env: z.array(z.string()).readonly().optional(),
    cwd: z.string().optional(),
    tty: z.boolean(),
    cols: z.int().optional(),
    rows: z.int().optional(),
    user: z.string().optional(),
    session: z.string().optional(),
    log: z.boolean().optional(),
    kill_grace_ms: z.int().optional(),
    resume_from: AgentResumeFromSchema.optional(),
  }),
  tap: z.object({
    op: z.literal('session.tap'),
    session: z.string(),
    resume_from: AgentResumeFromSchema.optional(),
  }),
  attach: z.object({
    op: z.literal('session.attach'),
    session: z.string(),
    cols: z.int().optional(),
    rows: z.int().optional(),
    resume_from: AgentResumeFromSchema.optional(),
  }),

  // dial: "tcp" with "host:port", or "unix" with a socket path; listen: "tcp"
  // with "127.0.0.1:port", or "unix" with a path or "" for one the agent makes
  relay: z.object({
    op: z.literal(['dial', 'listen']),
    network: z.enum(['tcp', 'unix']),
    address: z.string(),
  }),
  accept: z.object({ op: z.literal('agent.accept'), listener: z.string(), connection: z.int() }),
  servicesAdd: z.object({
    op: z.literal('services.add'),
    def: AgentServiceDefObjectSchema.omit({ source: true }).readonly(),
    replace: z.boolean().optional(),
  }),
  servicesLogs: z.object({
    op: z.literal('services.logs'),
    service: z.string(),
    lines: z.int().nonnegative(),
    follow: z.boolean(),
    cursor: LogCursorSchema.optional(),
  }),

  claim: z.object({ op: z.literal('claim'), claim: AgentClaimSchema }),
} as const;

export const AgentRequestSchema = z.union(Object.values(AgentRequestSchemas));

export type AgentRequest = z.input<typeof AgentRequestSchema>;

// the RESIZE and SIGNAL frames: a tty's size, and a Linux signal number for
// the process group
export const AgentResizeSchema = z.object({
  cols: z.int().nonnegative(),
  rows: z.int().nonnegative(),
});

export const AgentSignalSchema = z.object({ signal: z.int().positive() });

function readAgentSession(entry: unknown): AgentSession[] {
  const parsed = AgentSessionSchema.safeParse(entry);

  return parsed.success ? [parsed.data] : [];
}
