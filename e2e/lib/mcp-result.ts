import type { ToolResult } from './mcp';

// A tool call's structured answer; throws with the tool's own text when the
// call failed, so a failed step names its cause.
export function readToolData(result: Readonly<ToolResult>): Readonly<Record<string, unknown>> {
  if (result.isError) {
    throw new TypeError(`the tool failed: ${result.content[0]?.text ?? ''}`);
  }

  return result.structuredContent ?? {};
}
