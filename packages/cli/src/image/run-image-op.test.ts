import { expect, test } from 'bun:test';
import { createImpClient } from '@zgeoff/imp-client';
import { runImageAdd, runOnHostBuild } from './run-image-op';

const IMAGE = {
  id: 'i1',
  name: 'box',
  ref: 'busybox:1.37',
  digest: 'sha256:x',
  source: 'oci',
  createdAt: '2026-10-04T00:00:00.000Z',
  sizeBytes: 1,
};

// oRPC's event-iterator answer: each event, then its end
function buildEventStream(events: readonly unknown[]): Response {
  const lines = events.map(
    (event) => `event: message\ndata: ${JSON.stringify({ json: event })}\n\n`,
  );

  return new Response(`${lines.join('')}event: done\ndata: {}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

// An impd with or without the streams, as system.info says; it records the
// procedures called
function startImpd(streams: boolean) {
  const calls: string[] = [];
  const progress = { type: 'progress', phase: 'pull', elapsedMs: 0 };

  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname.replace(/^\/rpc\//u, '');

      calls.push(path);

      if (path === 'system/info') {
        return Response.json({ json: { features: { imageOpStream: streams } } });
      }

      if (path === 'images/addStream' || path === 'images/buildStream') {
        return buildEventStream([progress, { type: 'image', image: IMAGE }]);
      }

      return Response.json({ json: IMAGE });
    },
  });

  return {
    client: createImpClient({ url: `http://localhost:${String(server.port)}`, token: 't' }),
    calls,
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}

test('an impd with the streams adds and builds through them', async () => {
  await using impd = startImpd(true);

  const added = await runImageAdd(impd.client, { ref: 'busybox:1.37' }, 'imp image add');
  const built = await runOnHostBuild(impd.client, { contextDir: '/srv/ctx', name: 'box' });

  expect([added.name, built.name]).toEqual(['box', 'box']);

  expect(impd.calls).toEqual([
    'system/info',
    'images/addStream',
    'system/info',
    'images/buildStream',
  ]);
});

test('an older impd, without the streams, gets the calls that answer at the end', async () => {
  await using impd = startImpd(false);

  await runImageAdd(impd.client, { imp: 'dev', name: 'tpl' }, 'imp template create');
  await runOnHostBuild(impd.client, { contextDir: '/srv/ctx', name: 'box' });

  expect(impd.calls).toEqual(['system/info', 'images/add', 'system/info', 'images/build']);
});
