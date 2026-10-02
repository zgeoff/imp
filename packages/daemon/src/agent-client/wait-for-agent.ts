import { readErrorMessage } from '../read-error-message';
import { sendPing } from './agent-requests';
import type { AgentPing } from './agent-requests';

export interface WaitOptions {
  readonly deadlineMs: number;
  readonly firstDelayMs?: number;
  readonly maxDelayMs?: number;

  // how long one ping may take (default 1000)
  readonly attemptMs?: number;

  // wait for an agent parked in a boot template (true) or for one that
  // booted on (false); any answer when left out
  readonly isParked?: boolean;
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
    const attemptMs = Math.min(options.attemptMs ?? 1000, deadline - Date.now());

    try {
      const ping = await sendPing(vsockPath, Math.max(1, attemptMs));

      const isParked = ping.stage === 'template';

      if (options.isParked === undefined || options.isParked === isParked) {
        return ping;
      }

      const waitedFor = isParked ? 'still parked in the template' : 'not parked';

      lastError = new Error(waitedFor);
    } catch (error) {
      lastError = error;
    }

    await Bun.sleep(delay);

    delay = Math.min(maxDelay, delay * 2);
  }

  const reason = readErrorMessage(lastError);

  throw new Error(
    `agent did not answer within ${String(options.deadlineMs)} ms (last error: ${reason})`,
  );
}
