import type { Socket } from 'node:net';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeJsonFrame,
} from '@imp/daemon/src/agent-client/frame-codec';
import type { AgentService } from '@imp/daemon/src/agent-client/service-requests';
import { startStubAgent } from '@imp/daemon/src/test-utils/start-stub-agent';

// the user an image runs its services as, which the agent reports
const IMAGE_USER = 'dev';

function sendResponse(socket: Socket, value: unknown): void {
  socket.end(encodeJsonFrame(FRAME_TYPES.response, value));
}

// An imp's guest agent that keeps services and records each request. Like
// agent/internal/services, it refuses an add of a name it has without
// `replace` as SERVICE_EXISTS, and lists by name; other ops are UNKNOWN_OP.
export async function startStubServiceAgent(vsockPath: string) {
  const services: AgentService[] = [];
  const requests: unknown[] = [];

  const agent = await startStubAgent(vsockPath, (socket, request, frames) => {
    if (frames.length !== 1) {
      return;
    }

    const body: unknown = decodeJsonPayload(request);

    requests.push(body);

    const op: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'op') : null;

    const def: unknown =
      typeof body === 'object' && body !== null ? Reflect.get(body, 'def') : null;

    const isReplace =
      typeof body === 'object' && body !== null && Reflect.get(body, 'replace') === true;

    // the agent lists its services by name
    if (op === 'services.list') {
      const listed = services.toSorted((left, right) => left.name.localeCompare(right.name));

      sendResponse(socket, { services: listed, image_user: IMAGE_USER });

      return;
    }

    if (op === 'services.add' && typeof def === 'object' && def !== null) {
      const name = String(Reflect.get(def, 'name'));

      if (!isReplace && services.some((service) => service.name === name)) {
        sendResponse(socket, {
          error: { code: 'SERVICE_EXISTS', message: `service ${name} exists` },
        });

        return;
      }

      const kept = services.filter((service) => service.name !== name);

      services.splice(0, services.length, ...kept, {
        name,
        state: 'running',
        pid: 40 + kept.length,
        restarts: 0,
      });

      sendResponse(socket, { ok: true });

      return;
    }

    sendResponse(socket, { error: { code: 'UNKNOWN_OP', message: `unknown op ${String(op)}` } });
  });

  return {
    requests,
    close: () => {
      agent.close();
    },
  };
}
