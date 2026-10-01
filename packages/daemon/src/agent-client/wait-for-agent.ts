import { sendPing } from './agent-requests';
import type { AgentPing } from './agent-requests';

export interface WaitOptions {
  readonly deadlineMs: number;
  readonly firstDelayMs?: number;
  readonly maxDelayMs?: number;
}

// Pings until the agent answers. During boot the vsock socket may not exist
// yet, refuse the CONNECT, or close: every failure means retry until the
// deadline.
export async function waitForAgent(
  vsockPath: string,
  options: Readonly<WaitOptions>,
): Promise<AgentPing> {
  const deadline = Date.now() + options.deadlineMs;
  const maxDelay = options.maxDelayMs ?? 100;
  let delay = options.firstDelayMs ?? 5;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    const attemptMs = Math.min(1000, deadline - Date.now());

    try {
      return await sendPing(vsockPath, Math.max(1, attemptMs));
    } catch (error) {
      lastError = error;
    }

    await Bun.sleep(delay);

    delay = Math.min(maxDelay, delay * 2);
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);

  throw new Error(
    `agent did not answer within ${String(options.deadlineMs)} ms (last error: ${reason})`,
  );
}
