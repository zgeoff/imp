import { expect, mock, test } from 'bun:test';
import { buildMockGovernorDecision } from '@imp/api/test-utils/build-mock-governor-decision';
import { ORPCError } from '@orpc/client';
import { buildStubEventSource } from '../test-utils/build-stub-event-source';
import { printEvents } from './events';

test('it prints the named imp’s events and reconnects after an end or a network drop', () => {
  const dev = buildMockGovernorDecision({ name: 'dev' });
  const web = buildMockGovernorDecision({ name: 'web' });
  const print = mock<(line: string) => void>();

  const stub = buildStubEventSource({
    streams: [
      { events: [dev, web] },
      { failure: new TypeError('fetch failed') },
      { events: [dev] },
    ],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  const printing = printEvents(stub.source, 'dev', print);

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: impd closed it',
  );

  expect(print.mock.calls).toStrictEqual([[JSON.stringify(dev)], [JSON.stringify(dev)]]);
  expect(stub.backoffs).toStrictEqual([1000, 2000, 4000, 8000]);

  expect(stub.warnings).toStrictEqual([
    'imp: the event stream ended (impd closed it); reconnecting in 1000ms',
    'imp: the event stream ended (fetch failed); reconnecting in 2000ms',
    'imp: the event stream ended (impd closed it); reconnecting in 4000ms',
    'imp: the event stream ended (impd closed it); reconnecting in 8000ms',
  ]);
});

test('it prints every imp’s events when no imp is named', () => {
  const dev = buildMockGovernorDecision({ name: 'dev' });
  const web = buildMockGovernorDecision({ name: 'web' });
  const print = mock<(line: string) => void>();

  const stub = buildStubEventSource({
    streams: [{ events: [dev, web] }],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  const printing = printEvents(stub.source, null, print);

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: impd closed it',
  );

  expect(print.mock.calls).toStrictEqual([[JSON.stringify(dev)], [JSON.stringify(web)]]);
});

test('it starts the count and the backoff again after a stream that lasted', () => {
  const stub = buildStubEventSource({
    streams: [{}, {}, { lastsMs: 20_000 }],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  const printing = printEvents(stub.source, null, () => {});

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: impd closed it',
  );

  expect(stub.backoffs).toStrictEqual([1000, 2000, 1000, 2000, 4000, 8000]);
});

test('it reconnects after impd answers a server error', () => {
  const stub = buildStubEventSource({
    streams: [{ failure: new ORPCError('INTERNAL_SERVER_ERROR', { message: 'boom' }) }],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  const printing = printEvents(stub.source, null, () => {});

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: impd closed it',
  );

  expect(stub.warnings[0]).toBe('imp: the event stream ended (boom); reconnecting in 1000ms');
});

test('it says to upgrade an impd from before the stream', () => {
  const stub = buildStubEventSource({
    streams: [{ failure: new ORPCError('NOT_FOUND', { status: 404 }) }],
    check: { clientVersion: '0.3.0', serverVersion: '0.2.2', compatible: false },
  });

  expect(printEvents(stub.source, null, () => {})).rejects.toThrowWithMessage(
    Error,
    'impd 0.2.2 has no event stream; upgrade it to 0.3.0',
  );
});

test.each([
  ['UNAUTHORIZED', 401],
  ['FORBIDDEN', 403],
])('it rethrows a %s refusal without retrying', (code, status) => {
  const stub = buildStubEventSource({
    streams: [{ failure: new ORPCError(code, { status }) }],
    check: { clientVersion: '0.3.0', serverVersion: '0.3.0', compatible: true },
  });

  const printing = printEvents(stub.source, null, () => {});

  expect(printing).rejects.toMatchObject({ code, status });
  expect(stub.backoffs).toBeEmpty();
});
