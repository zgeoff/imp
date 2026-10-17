import { expect, mock, test } from 'bun:test';
import { Readable } from 'node:stream';
import { EVENT_VERSION } from '@impz/api';
import type { ImpEvent } from '@impz/api';
import { buildMockCheckpoint } from '@impz/api/test-utils/build-mock-checkpoint';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { ORPCError } from '@orpc/client';
import { UnknownProcedureError } from '../unknown-procedure-error';
import { watchEvents } from './watch-events';

test('it passes each event of the stream in order, then resolves once impd closes it', async () => {
  const added: ImpEvent = {
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpAdded',
    reason: 'snapshot',
    imp: buildMockImp({ name: 'box' }),
  };

  const changed: ImpEvent = {
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'slept',
    imp: buildMockImp({ name: 'box', state: 'sleeping' }),
  };

  const onEvent = mock<(event: ImpEvent) => void>();

  await watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([added, changed])) } },
    { onEvent },
  );

  expect(onEvent.mock.calls).toStrictEqual([[added], [changed]]);
});

test('it passes only the events of the named imp', async () => {
  const other: ImpEvent = {
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpAdded',
    reason: 'created',
    imp: buildMockImp({ name: 'other' }),
  };

  const checkpoint: ImpEvent = {
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'CheckpointAdded',
    name: 'box',
    checkpoint: buildMockCheckpoint(),
  };

  const onEvent = mock<(event: ImpEvent) => void>();

  await watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([other, checkpoint])) } },
    { onEvent, name: 'box' },
  );

  expect(onEvent).toHaveBeenCalledExactlyOnceWith(checkpoint);
});

test('it rejects with the stream’s failure when it has no reconnect', () => {
  const failure = new TypeError('Unable to connect');

  const watching = watchEvents(
    { events: { stream: () => Promise.reject(failure) } },
    { onEvent: () => {} },
  );

  expect(watching).rejects.toBe(failure);
});

test('it opens a fresh stream after one ends, numbering each open', async () => {
  const controller = new AbortController();

  const onOpen = mock<(attempt: number) => void>();

  // each answer made only once asked for, so no rejection goes unhandled
  const streams = buildStubAnswerQueue([
    () => Promise.resolve(Readable.from([])),
    () => Promise.reject(new TypeError('Unable to connect')),
    () => Promise.resolve(Readable.from([])),
  ]);

  await watchEvents(
    { events: { stream: () => streams.next()() } },
    {
      onEvent: () => {},
      onOpen: (attempt) => {
        onOpen(attempt);

        if (attempt === 3) {
          controller.abort();
        }
      },
      signal: controller.signal,
      reconnect: { delayMs: 1 },
    },
  );

  expect(onOpen.mock.calls).toStrictEqual([[1], [3]]);
  expect(streams.left).toBe(0);
});

test('it ends with impd’s refusal of the stream, without opening another', () => {
  const refusal = new ORPCError('FORBIDDEN', { status: 403 });

  const stream = mock(() => Promise.reject(refusal));

  const watching = watchEvents(
    { events: { stream } },
    { onEvent: () => {}, reconnect: { delayMs: 1 } },
  );

  expect(watching).rejects.toBe(refusal);
});

test('it ends on an impd that has no event stream, without opening another', async () => {
  const missing = new UnknownProcedureError('events.stream');

  const stream = mock(() => Promise.reject(missing));

  const watching = watchEvents(
    { events: { stream } },
    { onEvent: () => {}, reconnect: { delayMs: 1 } },
  );

  await expect(watching).toReject();

  expect(stream).toHaveBeenCalledOnce();
});

test('it ends with a failure the caller’s retry rule refuses', () => {
  const failure = new TypeError('Unable to connect');

  const watching = watchEvents(
    { events: { stream: () => Promise.reject(failure) } },
    { onEvent: () => {}, reconnect: { delayMs: 1, shouldRetry: () => false } },
  );

  expect(watching).rejects.toBe(failure);
});

test('it ends with what an event callback throws, even with a reconnect', () => {
  const removed: ImpEvent = {
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpRemoved',
    imp: buildMockImp({ name: 'box' }),
  };

  const failure = new Error('box was destroyed');

  const watching = watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([removed])) } },
    {
      onEvent: () => {
        throw failure;
      },
      reconnect: { delayMs: 1 },
    },
  );

  expect(watching).rejects.toBe(failure);
});

test('it ends with what the open callback throws', () => {
  const failure = new ORPCError('NOT_FOUND', { status: 404 });

  const watching = watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([])) } },
    {
      onEvent: () => {},
      onOpen: () => Promise.reject(failure),
    },
  );

  expect(watching).rejects.toBe(failure);
});

test('it closes the stream when the open callback throws', async () => {
  const close = mock(() => Promise.resolve({ done: true as const, value: undefined }));

  const stream: AsyncIterable<ImpEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
      return: close,
    }),
  };

  const watching = watchEvents(
    { events: { stream: () => Promise.resolve(stream) } },
    {
      onEvent: () => {},
      onOpen: () => Promise.reject(new Error('the snapshot failed')),
    },
  );

  await expect(watching).rejects.toThrow('the snapshot failed');

  expect(close).toHaveBeenCalledTimes(1);
});

test('it resolves once the signal aborts while it waits to reconnect', async () => {
  const controller = new AbortController();

  const watching = watchEvents(
    {
      events: {
        stream: () => {
          controller.abort();

          return Promise.reject(new TypeError('Unable to connect'));
        },
      },
    },
    { onEvent: () => {}, signal: controller.signal, reconnect: { delayMs: 60_000 } },
  );

  await expect(watching).toResolve();
});
