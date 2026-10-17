import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import * as z from 'zod';
import type { ImpdFeature } from '../require-features';

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());

// the two answers that carry impd's feature flags
const FEATURE_PATHS = new Set(['/rpc/system/features', '/rpc/system/info']);

// what this stand-in reads of either answer
const FeatureAnswerSchema = z.looseObject({
  features: z.record(z.string(), z.boolean().optional()).optional(),
});

// an impd that lacks `feature`, in front of a real impd's `handle`: its
// system.features and system.info answer without that flag, as an older
// release does; every other call passes through unchanged
export function buildStubImpdWithoutFeature(
  handle: (request: Request) => Promise<Response>,
  feature: ImpdFeature,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await handle(request);

    if (!FEATURE_PATHS.has(new URL(request.url).pathname) || !response.ok) {
      return response;
    }

    const body: unknown = await response.json();

    const answer = FeatureAnswerSchema.parse(serializer.deserialize(body));
    const { [feature]: _dropped, ...features } = answer.features ?? {};

    return Response.json(serializer.serialize({ ...answer, features }));
  };
}
