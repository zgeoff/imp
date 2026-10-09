import { expect, test } from 'bun:test';
import { buildStubImpdWithNewReason } from './build-stub-impd-with-new-reason';

test('it gives an ImpChanged event the new reason and keeps the rest of the line', async () => {
  const newer = buildStubImpdWithNewReason(
    () =>
      Promise.resolve(
        new Response(
          'event: message\ndata: {"json":{"v":1,"ev":"ImpChanged","reason":"slept"},"meta":[[1,"at"]]}\n\n',
        ),
      ),
    'from-the-future',
  );

  const response = await newer(
    new Request('http://impd.test/rpc/events/stream', { method: 'POST' }),
  );

  const text = await response.text();

  expect(text).toBe(
    'event: message\ndata: {"json":{"v":1,"ev":"ImpChanged","reason":"from-the-future"},"meta":[[1,"at"]]}\n\n',
  );
});

test('it leaves an event that is not ImpChanged as it is', async () => {
  const newer = buildStubImpdWithNewReason(
    () =>
      Promise.resolve(
        new Response(
          'event: message\ndata: {"json":{"v":1,"ev":"ImpAdded","reason":"snapshot"}}\n\n',
        ),
      ),
    'from-the-future',
  );

  const response = await newer(
    new Request('http://impd.test/rpc/events/stream', { method: 'POST' }),
  );

  const text = await response.text();

  expect(text).toBe(
    'event: message\ndata: {"json":{"v":1,"ev":"ImpAdded","reason":"snapshot"}}\n\n',
  );
});

test('it renames the reason of a line that arrives in two chunks', async () => {
  const chunks = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('data: {"json":{"ev":"ImpCha'));
      controller.enqueue(new TextEncoder().encode('nged","reason":"woke"}}\n\n'));
      controller.close();
    },
  });

  const newer = buildStubImpdWithNewReason(
    () => Promise.resolve(new Response(chunks)),
    'from-the-future',
  );

  const response = await newer(
    new Request('http://impd.test/rpc/events/stream', { method: 'POST' }),
  );

  const text = await response.text();

  expect(text).toBe('data: {"json":{"ev":"ImpChanged","reason":"from-the-future"}}\n\n');
});

test('it passes another call through unchanged', async () => {
  const answer = Response.json({ json: { ev: 'ImpChanged', reason: 'slept' } });
  const newer = buildStubImpdWithNewReason(() => Promise.resolve(answer), 'from-the-future');

  const response = await newer(new Request('http://impd.test/rpc/imps/list', { method: 'POST' }));

  expect(response).toBe(answer);
});
