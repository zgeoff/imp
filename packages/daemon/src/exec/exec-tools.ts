import type { ExecTool } from '@imp/api';
import type { AgentFeature } from '../agent-client/agent-outdated';
import type { AgentExecRequest } from '../agent-client/exec-stream';

// the agent binary on the system drive, so every image has its tools
export const SYSTEM_AGENT_PATH = '/run/imp/sys/imp-agent';

// the agent version each tool needs
export const TOOL_FEATURES: Readonly<Record<ExecTool, AgentFeature>> = { tar: 'cp' };

// A tool runs as root: `imp cp` writes where the image user cannot, and
// sets the owner it is given.
export function buildToolRequest(tool: ExecTool, args: readonly string[]): AgentExecRequest {
  return { argv: [SYSTEM_AGENT_PATH, tool, ...args], tty: false, user: 'root' };
}
