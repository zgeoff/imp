import { expect, test } from 'bun:test';
import { os } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { createImpClient } from './create-imp-client';

// An impd newer than this client sends a reason it does not know: the client
// passes it through, since oRPC checks outputs on the server, not here. A
// new ImpChangeReason needs no EVENT_VERSION bump.
test('an event with a reason this client does not know still arrives', async () => {
  const future = { v: 1, at: new Date(0), ev: 'ImpChanged', reason: 'from-the-future', imp: {} };

  const router = {
    events: {
      // eslint-disable-next-line @typescript-eslint/require-await
      stream: os.handler(async function* streamFuture() {
        yield future;
      }),
    },
  };

  const handler = new RPCHandler(router);

  const client = createImpClient({
    url: 'http://impd.test/',
    fetch: async (request) => {
      const handled = await handler.handle(request, { prefix: '/rpc', context: {} });

      return handled.response ?? new Response('not found', { status: 404 });
    },
  });

  const events = await client.events.stream();

  const received: unknown[] = [];

  for await (const event of events) {
    received.push(event);
  }

  expect(received).toEqual([future]);
});
