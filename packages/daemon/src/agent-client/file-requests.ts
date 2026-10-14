import { handleUnknownOp } from './agent-outdated';
import { FilesRemovedSchema, OKSchema } from './agent-protocol';
import { sendAgentRequest } from './agent-requests';
import { decodeAgentMessage } from './decode-agent-message';

// The agent's files ops (docs/architecture/guest/agent.md#read-only-files).
// Each throws AgentError BAD_REQUEST for a path the agent refuses, NO_SPACE
// when its files are full, and AGENT_OUTDATED for an agent from before them.

export async function sendFilesWrite(
  vsockPath: string,
  path: string,
  data: Uint8Array,
): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'files.write', path, data }).catch(
    handleUnknownOp('files'),
  );

  decodeAgentMessage(OKSchema, response);
}

// whether a file was there to remove
export async function sendFilesRemove(vsockPath: string, path: string): Promise<boolean> {
  const response = await sendAgentRequest(vsockPath, { op: 'files.remove', path }).catch(
    handleUnknownOp('files'),
  );

  return decodeAgentMessage(FilesRemovedSchema, response).removed;
}
