import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());

// The input of an oRPC call, as the procedure receives it, read from a copy
// of the request the SDK sent; for a per-test MSW handler that captures it
export async function readRpcInput(request: Readonly<Request>): Promise<unknown> {
  const body: unknown = await request.clone().json();

  return serializer.deserialize(body);
}
