import type { Socket } from 'node:net';
import type { JsonValue } from '@bufbuild/protobuf';
import { FILE_DATA_MAX_BYTES, FILE_SEGMENT_PATTERN } from '@imp/api';
import { RequestSchema } from '../agent-client/agent-protocol';
import type { Request } from '../agent-client/agent-protocol';
import { decodeAgentMessage } from '../agent-client/decode-agent-message';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

interface StubFilesAgentOptions {
  // false: an agent from before the read-only files, which answers their
  // ops UNKNOWN_OP
  readonly knowsFiles: boolean;

  // closes with this stack, else at the test's end
  readonly stack?: Readonly<AsyncDisposableStack>;
}

function sendResponse(socket: Socket, value: JsonValue): void {
  socket.end(encodeJsonFrame(FRAME_TYPES.response, value));
}

function sendError(socket: Socket, code: string, message: string): void {
  sendResponse(socket, { error: { code, message } });
}

// An imp's agent on `vsockPath` keeping read-only files as agent/internal/
// files does: BAD_REQUEST for a path or size it refuses, and NO_SPACE for
// every write while `full.isFull`. `files` holds each file's text.
export async function startStubFilesAgent(
  vsockPath: string,
  options: Readonly<StubFilesAgentOptions>,
) {
  const files = new Map<string, string>();

  const requests: Request[] = [];
  const full = { isFull: false };

  const agent = await startStubAgent(
    vsockPath,
    (socket, frame) => {
      const request = decodeAgentMessage(RequestSchema, decodeJsonPayload(frame));

      requests.push(request);

      if (!options.knowsFiles) {
        sendError(socket, 'UNKNOWN_OP', `unknown op ${request.op}`);

        return;
      }

      const path = request.path ?? '';
      const segments = path.split('/');

      if (
        path.length === 0 ||
        path.length > 512 ||
        segments.length > 8 ||
        !segments.every((segment) => FILE_SEGMENT_PATTERN.test(segment))
      ) {
        sendError(socket, 'BAD_REQUEST', `path ${path} is not allowed`);

        return;
      }

      if (request.op === 'files.remove') {
        sendResponse(socket, { removed: files.delete(path) });

        return;
      }

      const data = request.data ?? new Uint8Array();

      if (data.byteLength > FILE_DATA_MAX_BYTES) {
        sendError(socket, 'BAD_REQUEST', `data is ${data.byteLength} bytes, over the cap`);

        return;
      }

      if (full.isFull) {
        sendError(socket, 'NO_SPACE', 'the read-only files are full');

        return;
      }

      files.set(path, new TextDecoder().decode(data));

      sendResponse(socket, { ok: true });
    },
    { ...(options.stack !== undefined && { stack: options.stack }) },
  );

  return { files, requests, full, close: agent.close };
}
