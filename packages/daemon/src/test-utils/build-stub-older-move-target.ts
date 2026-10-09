import { MOVE_PATHS, MoveOfferReplySchema } from '../moves/move-header';
import type { FetchHook } from '../moves/test-moves';

// the offer reply fields a target added over time; an older target leaves
// each out, and the source reads it as false
type OfferField = 'keepsMaxMemory' | 'keepsLeases' | 'keepsPublicEgress';

// A target from before `field`: its offer reply leaves the field out, as
// that release's impd answered it. Every other request reaches the target.
export function buildStubOlderMoveTarget(field: OfferField): FetchHook {
  return async (request, forward) => {
    const response = await forward();

    if (!request.url.endsWith(MOVE_PATHS.offer)) {
      return response;
    }

    const body: unknown = await response.json();

    const reply = Object.entries(MoveOfferReplySchema.parse(body)).filter(([key]) => key !== field);

    return Response.json(Object.fromEntries(reply), { status: response.status });
  };
}
