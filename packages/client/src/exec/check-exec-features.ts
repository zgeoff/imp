import { ORPCError } from '@orpc/client';
import { MissingFeatureError, requireFeatures } from '../require-features';
import type { FeatureNeeds, FeatureSource } from '../require-features';
import type { ExecOutcome } from './open-exec-session';

const CHECK_TIMEOUT_MS = 5000;

// An older impd drops a start field it does not know and runs the command
// anyway, so a start that sets one asks impd first. Null when impd has every
// feature; otherwise the outcome that ends the session unstarted.
export async function checkExecFeatures(
  rpc: FeatureSource,
  needs: FeatureNeeds,
): Promise<ExecOutcome | null> {
  try {
    await requireFeatures(rpc, needs, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });

    return null;
  } catch (error) {
    return buildRefusal(error);
  }
}

function buildRefusal(error: unknown): ExecOutcome {
  if (error instanceof MissingFeatureError) {
    const detail = `this impd ${error.gap} and would ${error.outcome}`;

    return {
      kind: 'failed',
      code: 'PRECONDITION_FAILED',
      message: `nothing was started: ${detail}`,
      data: { reason: 'impd_outdated', detail },
    };
  }

  // any answer from impd, or from a proxy in front of it, is an ORPCError;
  // no answer is a TypeError or a timeout
  if (error instanceof ORPCError && error.status === 401) {
    return { kind: 'unauthorized' };
  }

  if (error instanceof ORPCError) {
    return {
      kind: 'failed',
      code: null,
      message: `impd answered the feature check with ${String(error.status)}; nothing was started`,
    };
  }

  const detail = error instanceof Error ? error.message : String(error);

  return { kind: 'unreachable', detail: `feature check: ${detail}` };
}
