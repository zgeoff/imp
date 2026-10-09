import { MOVE_PATHS } from '../moves/move-header';
import type { FetchHook } from '../moves/test-moves';

interface DroppedCommitOptions {
  // how many commits the network drops before it lets one through
  readonly count?: number;

  // `request`: the commit never reaches the target; `answer`: the target
  // commits, and its answer never reaches the source
  readonly drops?: 'request' | 'answer';
}

// A network that drops the first commits of a move, as a cut connection
// would: the source's fetch rejects. Every other request goes as sent.
export function buildStubDroppedCommit(options: Readonly<DroppedCommitOptions> = {}): FetchHook {
  const left = { count: options.count ?? 1 };
  const drops = options.drops ?? 'request';

  return async (request, forward) => {
    if (!request.url.endsWith(MOVE_PATHS.commit) || left.count === 0) {
      return forward();
    }

    left.count -= 1;

    if (drops === 'request') {
      throw new Error('the network dropped the commit');
    }

    await forward();

    throw new Error('the network dropped the answer');
  };
}
