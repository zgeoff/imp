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

function sendError(socket: Socket, code: string): void {
  sendResponse(socket, { error: { code, message: code.toLowerCase() } });
}

// An imp's guest agent on `vsockPath` that keeps services as
// agent/internal/services does; an argv of `bad` is its BAD_REQUEST. Each
// log is one file whose logs call sends it from the cursor, then a CURSOR.
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

  const toService = (def: z.infer<typeof AgentDefSchema>): AgentService => ({
    name: def.name,
    state: 'running',
    pid: 40 + services.length,
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

  const handleLogs = (socket: Socket, request: Readonly<AgentRequest>): void => {
    const service = request.service ?? '';
    const log = logs.get(service) ?? Buffer.alloc(0);
    const from = request.cursor?.offset ?? 0;

    if (failing.logs) {
      sendError(socket, 'INTERNAL');

      return;
    }

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
      sendError(socket, 'BAD_REQUEST');

      return;
    }

    const taken = services.findIndex((service) => service.name === def.name);

    if (taken !== -1 && request.replace !== true) {
      sendError(socket, 'SERVICE_EXISTS');

      return;
    }

    const at = taken === -1 ? services.length : taken;

    services.splice(at, 1, toService(def));

    sendResponse(socket, { ok: true });
  };

  const handleRequest = (socket: Socket, request: Readonly<AgentRequest>): void => {
    requests.push(request);

    const index = services.findIndex((service) => service.name === request.service);

    if (request.op === 'services.list' && failing.list) {
      sendError(socket, 'INTERNAL');
    } else if (request.op === 'services.list') {
      sendResponse(socket, {
        services,
        ...(options.knowsServices && { image_user: IMAGE_USER }),
      });
    } else if (!options.knowsServices) {
      sendError(socket, 'UNKNOWN_OP');
    } else if (request.op === 'services.add') {
      handleAdd(socket, request);
    } else if (index === -1 && !logs.has(request.service ?? '')) {
      sendError(socket, 'NO_SERVICE');
    } else if (request.op === 'services.remove') {
      services.splice(index, 1);

      sendResponse(socket, { ok: true });
    } else if (request.op === 'services.restart') {
      sendResponse(socket, { ok: true });
    } else if (request.op === 'services.logs') {
      handleLogs(socket, request);
    } else {
      sendError(socket, 'UNKNOWN_OP');
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
