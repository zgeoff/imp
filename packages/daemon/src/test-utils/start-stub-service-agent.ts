import type { Socket } from 'node:net';
import * as z from 'zod';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '../agent-client/frame-codec';
import type { AgentService } from '../agent-client/service-requests';
import { startStubAgent } from './start-stub-agent';

// the user the image runs its services as, which a current agent reports
const IMAGE_USER = 'dev';

// the inode of every service's log file
const LOG_INODE = 7;

// the most lines a logs call may ask for, as the agent's MaxLogLines
const MAX_LOG_LINES = 100_000;

// the newline byte, which ends each line of a log
const NEWLINE = 0x0a;

const AgentDefSchema = z.object({
  name: z.string(),
  argv: z.array(z.string()).readonly(),
  env: z.array(z.string()).readonly().optional(),
  user: z.string().optional(),
  restart: z.enum(['always', 'on-failure', 'never']).optional(),
});

const AgentRequestSchema = z.object({
  op: z.string(),
  service: z.string().optional(),
  def: AgentDefSchema.optional(),
  replace: z.boolean().optional(),
  lines: z.int().optional(),
  follow: z.boolean().optional(),
  cursor: z.object({ inode: z.int(), offset: z.int() }).optional(),
});

type AgentRequest = z.infer<typeof AgentRequestSchema>;

// one open follow of a service's log
interface Follow {
  readonly service: string;
  readonly socket: Socket;
  isClosed: boolean;
}

interface StubServiceAgentOptions {
  // false: an agent from before the services API, which knows only
  // services.list and lists no definitions
  readonly knowsServices: boolean;

  // closes with this stack, else at the test's end
  readonly stack?: Readonly<AsyncDisposableStack>;
}

function sendResponse(socket: Socket, value: unknown): void {
  socket.end(encodeJsonFrame(FRAME_TYPES.response, value));
}

function sendError(socket: Socket, code: string, message: string): void {
  sendResponse(socket, { error: { code, message } });
}

// Where the last `count` lines of `log` start, as the agent's findLastLines
// reads them: the newline that ends the log ends its last line, and a last
// line without one counts as a line.
function findLastLines(log: Buffer, count: number): number {
  if (count === 0) {
    return log.length;
  }

  const body = log.at(-1) === NEWLINE ? log.length - 1 : log.length;
  let found = 0;

  for (let at = body - 1; at >= 0; at -= 1) {
    if (log[at] === NEWLINE) {
      found += 1;

      if (found === count) {
        return at + 1;
      }
    }
  }

  return 0;
}

// An imp's guest agent on `vsockPath` that keeps services as
// agent/internal/services does; an argv of `bad` is its BAD_REQUEST. Each
// log is one file, which a removed service keeps.
export async function startStubServiceAgent(
  vsockPath: string,
  options: Readonly<StubServiceAgentOptions>,
) {
  const services: AgentService[] = [];
  const requests: AgentRequest[] = [];

  const logs = new Map<string, Buffer>();

  const follows: Follow[] = [];

  // while set, the agent refuses every log open, or every list, as INTERNAL
  const failing = { logs: false, list: false };

  // the pid the next start runs: an add, a replace and a restart each start
  // a new process
  const pids = { next: 40 };

  const startProcess = (): number => {
    const pid = pids.next;

    pids.next += 1;

    return pid;
  };

  const toService = (def: z.infer<typeof AgentDefSchema>): AgentService => ({
    name: def.name,
    state: 'running',
    pid: startProcess(),
    restarts: 0,
    ...(options.knowsServices && {
      def: { ...def, restart: def.restart ?? 'always', source: 'api' as const },
      root: (def.user ?? IMAGE_USER) === 'root',
    }),
  });

  const sendLog = (socket: Socket, data: Uint8Array, end: number): void => {
    socket.write(encodeFrame(FRAME_TYPES.stdout, data));
    socket.write(encodeJsonFrame(FRAME_TYPES.cursor, { inode: LOG_INODE, offset: end }));
  };

  // the last `lines` lines; or from a cursor, unless the log shrank below it
  // or it names another file, which sends the whole log
  const findLogStart = (log: Buffer, request: Readonly<AgentRequest>): number => {
    if (request.cursor === undefined) {
      return findLastLines(log, request.lines ?? 0);
    }

    const cursor = request.cursor;

    return cursor.inode === LOG_INODE && cursor.offset <= log.length ? cursor.offset : 0;
  };

  const handleLogs = (socket: Socket, request: Readonly<AgentRequest>): void => {
    const service = request.service ?? '';
    const log = logs.get(service) ?? Buffer.alloc(0);
    const lines = request.lines ?? 0;

    if (lines < 0 || lines > MAX_LOG_LINES) {
      sendError(socket, 'BAD_REQUEST', 'lines: want 0 to 100000');

      return;
    }

    if (failing.logs) {
      sendError(socket, 'INTERNAL', 'the log could not be read');

      return;
    }

    const from = findLogStart(log, request);

    socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));

    if (from < log.length) {
      sendLog(socket, log.subarray(from), log.length);
    }

    if (request.follow !== true) {
      socket.end(encodeFrame(FRAME_TYPES.stdoutEof));

      return;
    }

    const follow: Follow = { service, socket, isClosed: false };

    follows.push(follow);

    socket.on('close', () => {
      follow.isClosed = true;
    });
  };

  const handleAdd = (socket: Socket, request: Readonly<AgentRequest>): void => {
    const def = request.def;

    if (def === undefined || def.argv[0] === 'bad') {
      sendError(socket, 'BAD_REQUEST', 'argv is bad');

      return;
    }

    const taken = services.findIndex((service) => service.name === def.name);

    if (taken !== -1 && request.replace !== true) {
      sendError(socket, 'SERVICE_EXISTS', `service ${def.name} exists`);

      return;
    }

    const at = taken === -1 ? services.length : taken;

    services.splice(at, 1, toService(def));

    sendResponse(socket, { ok: true });
  };

  // a remove or a restart needs the service itself: a log that a removed
  // service left is NO_SERVICE to both, as it is to the agent
  const handleChange = (socket: Socket, request: Readonly<AgentRequest>): void => {
    const name = request.service ?? '';
    const index = services.findIndex((service) => service.name === name);
    const service = services[index];

    if (service === undefined) {
      sendError(socket, 'NO_SERVICE', `no service ${name}`);

      return;
    }

    if (request.op === 'services.remove') {
      services.splice(index, 1);
    } else {
      // a new process, which has no last exit yet
      const { last_exit: _lastExit, ...kept } = service;

      services.splice(index, 1, { ...kept, state: 'running', pid: startProcess(), restarts: 0 });
    }

    sendResponse(socket, { ok: true });
  };

  const handleRequest = (socket: Socket, request: Readonly<AgentRequest>): void => {
    requests.push(request);

    const name = request.service ?? '';
    const isKnown = services.some((service) => service.name === name) || logs.has(name);

    if (request.op === 'services.list' && failing.list) {
      sendError(socket, 'INTERNAL', 'the services could not be listed');
    } else if (request.op === 'services.list') {
      sendResponse(socket, {
        // by name in byte order, as the agent's sort; names are unique
        services: services.toSorted((left, right) => (left.name < right.name ? -1 : 1)),
        ...(options.knowsServices && { image_user: IMAGE_USER }),
      });
    } else if (!options.knowsServices) {
      sendError(socket, 'UNKNOWN_OP', `unknown op ${request.op}`);
    } else if (request.op === 'services.add') {
      handleAdd(socket, request);
    } else if (request.op === 'services.remove' || request.op === 'services.restart') {
      handleChange(socket, request);
    } else if (request.op === 'services.logs' && !isKnown) {
      sendError(socket, 'NO_SERVICE', `no service ${name}`);
    } else if (request.op === 'services.logs') {
      handleLogs(socket, request);
    } else {
      sendError(socket, 'UNKNOWN_OP', `unknown op ${request.op}`);
    }
  };

  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  const agent = await startStubAgent(
    vsockPath,
    (socket, request, frames) => {
      if (frames.length === 1) {
        handleRequest(socket, AgentRequestSchema.parse(decodeJsonPayload(request)));
      }
    },
    closeWith,
  );

  return {
    services,
    requests,
    follows,
    failing,
    close: agent.close,

    // adds to the service's log file and sends the bytes to each follow
    writeLog: (service: string, text: string | Uint8Array): void => {
      const data = typeof text === 'string' ? new TextEncoder().encode(text) : text;
      const log = Buffer.concat([logs.get(service) ?? Buffer.alloc(0), data]);

      logs.set(service, log);

      for (const follow of follows) {
        if (follow.service === service && !follow.isClosed) {
          sendLog(follow.socket, data, log.length);
        }
      }
    },

    // what a VM going to sleep does to its vsock connections
    stopFollows: (): void => {
      for (const follow of follows) {
        follow.socket.destroy();
      }
    },
  };
}
