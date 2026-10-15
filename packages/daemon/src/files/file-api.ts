import { FILES_GUEST_DIR } from '@impz/api';
import { ORPCError } from '@orpc/server';
import { sendFilesRemove, sendFilesWrite } from '../agent-client/file-requests';
import { isAgentError } from '../agent-client/is-agent-error';
import { buildAgentOutdatedApiError } from '../api-errors';
import type { ImpRuntime } from '../imps/imp-runtime';

// The `files` API (docs/architecture/guest/agent.md#read-only-files) through
// the guest agent: impd writes each file, and the guest sees it read-only
// under FILES_GUEST_DIR. A call wakes or boots the imp, as an exec does.
export interface FileApi {
  // answers the file's path in the guest
  readonly writeFile: (
    name: string,
    path: string,
    content: string,
  ) => Promise<{ readonly path: string }>;
  readonly removeFile: (name: string, path: string) => Promise<{ readonly removed: boolean }>;
}

interface FileApiParts {
  readonly runtime: Pick<ImpRuntime, 'sendToAgent'>;
}

export function createFileApi(parts: FileApiParts): FileApi {
  const runtime = parts.runtime;

  return {
    writeFile: async (name, path, content) => {
      const data = new TextEncoder().encode(content);

      await runtime
        .sendToAgent(name, (vsockPath) => sendFilesWrite(vsockPath, path, data), 'files')
        .catch((error: unknown) => {
          throw toApiError(error);
        });

      return { path: `${FILES_GUEST_DIR}/${path}` };
    },

    removeFile: async (name, path) => {
      const removed = await runtime
        .sendToAgent(name, (vsockPath) => sendFilesRemove(vsockPath, path), 'files')
        .catch((error: unknown) => {
          throw toApiError(error);
        });

      return { removed };
    },
  };
}

// a path the agent refuses and a full tree are the caller's to fix
function toApiError(error: unknown): unknown {
  if (isAgentError(error, 'BAD_REQUEST') || isAgentError(error, 'NO_SPACE')) {
    return new ORPCError('BAD_REQUEST', { message: error.detail });
  }

  if (isAgentError(error, 'AGENT_OUTDATED')) {
    return buildAgentOutdatedApiError(error.message);
  }

  return error;
}
