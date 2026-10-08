import { expect, test } from 'bun:test';
import { buildMockGovernorDecision } from '@imp/api/test-utils/build-mock-governor-decision';
import { buildStubEventSource } from './build-stub-event-source';

test('it plays each stream’s events in turn', async () => {
  const first = buildMockGovernorDecision({ name: 'dev' });
  const second = buildMockGovernorDecision({ name: 'web' });

  const stub = buildStubEventSource({
    streams: [{ events: [first] }, { events: [second] }],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  const firstStream = await stub.source.openStream();
  const firstEvents = await Array.fromAsync(firstStream);
  const secondStream = await stub.source.openStream();
  const secondEvents = await Array.fromAsync(secondStream);

  expect(firstEvents).toStrictEqual([first]);
  expect(secondEvents).toStrictEqual([second]);
});

test('it ends each stream at once after the script runs out', async () => {
  const stub = buildStubEventSource({
    streams: [],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  const stream = await stub.source.openStream();
  const received = await Array.fromAsync(stream);

  expect(received).toBeEmpty();
});

test('it rejects the open of a stream that fails', () => {
  const stub = buildStubEventSource({
    streams: [{ failure: new TypeError('fetch failed') }],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  expect(stub.source.openStream()).rejects.toThrowWithMessage(TypeError, 'fetch failed');
});

test('it moves its clock by how long each stream lasts', async () => {
  const stub = buildStubEventSource({
    streams: [{ lastsMs: 20_000 }],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  await stub.source.openStream();

  expect(stub.source.now()).toBe(20_000);
});

test('it records each wait and warning without waiting', async () => {
  const stub = buildStubEventSource({
    streams: [],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  await stub.source.wait(1000);

  stub.source.warn('imp: the event stream ended');

  expect([stub.backoffs, stub.warnings]).toStrictEqual([[1000], ['imp: the event stream ended']]);
});

test('it answers the version check with the check it was given', async () => {
  const stub = buildStubEventSource({
    streams: [],
    check: { clientVersion: '0.3.0', serverVersion: '0.2.2', compatible: false },
  });

  const check = await stub.source.checkServer();

  expect(check).toStrictEqual({
    clientVersion: '0.3.0',
    serverVersion: '0.2.2',
    compatible: false,
  });
});
