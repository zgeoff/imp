import { MOVE_PATHS, MoveOfferReplySchema } from '../moves/move-header';
import type { FetchHook } from '../moves/test-moves';

// A target whose storage changed between the prepare and the send, as a
// host moved to another backend would: its offer reply names `storage`.
// Every other request's answer goes as the target sent it.
export function buildStubSwitchedStorageTarget(storage: 'xfs' | 'zfs'): FetchHook {
  return async (request, forward) => {
    const response = await forward();

    if (!request.url.endsWith(MOVE_PATHS.offer)) {
      return response;
    }

    const body: unknown = await response.json();

    const reply = MoveOfferReplySchema.parse(body);

    return Response.json({ ...reply, storage }, { status: response.status });
  };
}
