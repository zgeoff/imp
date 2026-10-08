import { expect, mock, onTestFinished, test } from 'bun:test';
import type { Imp } from '@imp/api';
import { EVENT_VERSION } from '@imp/api';
import { waitFor } from '@imp/test-utils/wait-for';
import { buildMockImp } from '../test-utils/build-mock-imp';
import { buildMockImpChangedEvent } from '../test-utils/build-mock-imp-changed-event';
import { emitImpdEvent, impdEventListeners, impdLogouts, openImpdEventStream } from './impd-events';

test('#openImpdEventStream opens with a snapshot of the imps', async () => {
  const imp = buildMockImp({ name: 'web' });

  const stream = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    () => [imp],
    undefined,
  );

  onTestFinished(() => stream.return(undefined));

  const snapshot = await stream.next();

  expect(snapshot.value).toStrictEqual({
    v: EVENT_VERSION,
    at: expect.toBeValidDate(),
    ev: 'ImpAdded',
    reason: 'snapshot',
    imp,
  });
});

test('#openImpdEventStream leaves imps outside the patterns out of the snapshot', async () => {
  const stream = openImpdEventStream(
    { imps: ['dev-*'], expiresAt: new Date(Date.now() + 60_000) },
    () => [buildMockImp({ name: 'prod' }), buildMockImp({ name: 'dev-web' })],
    undefined,
  );

  onTestFinished(() => stream.return(undefined));

  const snapshot = await stream.next();

  expect(snapshot.value).toMatchObject({ imp: { name: 'dev-web' } });
});

test('#openImpdEventStream sends events emitted while it was not reading, in order', async () => {
  const stream = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    () => [],
    undefined,
  );

  onTestFinished(() => stream.return(undefined));

  const slept = buildMockImpChangedEvent({ reason: 'slept', imp: { name: 'web' } });
  const woke = buildMockImpChangedEvent({ reason: 'woke', imp: { name: 'web' } });
  const first = stream.next();

  emitImpdEvent(slept);
  emitImpdEvent(woke);

  const firstEvent = await first;
  const secondEvent = await stream.next();

  expect(firstEvent.value).toStrictEqual(slept);
  expect(secondEvent.value).toStrictEqual(woke);
});

test('#openImpdEventStream sends a reader that read its snapshot an event emitted later', async () => {
  const readImps = mock((): readonly Imp[] => []);

  const stream = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    readImps,
    undefined,
  );

  onTestFinished(() => stream.return(undefined));

  const pending = stream.next();
  const event = buildMockImpChangedEvent({ imp: { name: 'web' } });

  await waitFor(() => {
    expect(readImps).toHaveBeenCalledOnce();
  });

  emitImpdEvent(event);

  const received = await pending;

  expect(received.value).toStrictEqual(event);
});

test('#openImpdEventStream leaves out the events of imps outside the patterns', async () => {
  const stream = openImpdEventStream(
    { imps: ['dev-*'], expiresAt: new Date(Date.now() + 60_000) },
    () => [],
    undefined,
  );

  onTestFinished(() => stream.return(undefined));

  const pending = stream.next();
  const allowed = buildMockImpChangedEvent({ imp: { name: 'dev-web' } });

  emitImpdEvent(buildMockImpChangedEvent({ imp: { name: 'prod' } }));
  emitImpdEvent(allowed);

  const received = await pending;

  expect(received.value).toStrictEqual(allowed);
});

test('#openImpdEventStream lets go of its listener once the caller aborts it', async () => {
  const controller = new AbortController();

  const readImps = mock((): readonly Imp[] => []);

  const stream = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    readImps,
    controller.signal,
  );

  const pending = stream.next();

  await waitFor(() => {
    expect(readImps).toHaveBeenCalledOnce();
  });

  const listening = impdEventListeners.size;

  controller.abort();

  const ended = await pending;

  expect(listening).toBe(1);
  expect(ended.done).toBe(true);
  expect(impdEventListeners.size).toBe(0);
});

test('#emitImpdEvent sends the event to every open stream', async () => {
  const first = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    () => [],
    undefined,
  );

  onTestFinished(() => first.return(undefined));

  const second = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    () => [],
    undefined,
  );

  onTestFinished(() => second.return(undefined));

  const event = buildMockImpChangedEvent({ imp: { name: 'web' } });
  const firstPending = first.next();
  const secondPending = second.next();

  emitImpdEvent(event);

  const firstReceived = await firstPending;
  const secondReceived = await secondPending;

  expect(firstReceived.value).toStrictEqual(event);
  expect(secondReceived.value).toStrictEqual(event);
});

test('#impdLogouts ends every open stream at a logout', async () => {
  const readImps = mock((): readonly Imp[] => []);

  const stream = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    readImps,
    undefined,
  );

  onTestFinished(() => stream.return(undefined));

  const pending = stream.next();

  await waitFor(() => {
    expect(readImps).toHaveBeenCalledOnce();
  });

  impdLogouts.logOut();

  const ended = await pending;

  expect(ended.done).toBe(true);
});

// The expiry runs on impd's real timer, so the short stream ends 50 ms on:
// it must still pass the event sent before then, and the control, a day
// from expiry, must still be open after it ends
test('#openImpdEventStream ends when the session expires and not before', async () => {
  const expiring = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 50) },
    () => [],
    undefined,
  );

  onTestFinished(() => expiring.return(undefined));

  const control = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 86_400_000) },
    () => [],
    undefined,
  );

  onTestFinished(() => control.return(undefined));

  const before = buildMockImpChangedEvent({ imp: { name: 'web' } });
  const after = buildMockImpChangedEvent({ imp: { name: 'db' } });
  const expiringNext = expiring.next();
  const controlFirstNext = control.next();

  emitImpdEvent(before);

  const passed = await expiringNext;
  const ended = await expiring.next();
  const controlFirst = await controlFirstNext;

  const controlNext = control.next();

  emitImpdEvent(after);

  const controlRead = await controlNext;

  expect(passed.value).toStrictEqual(before);
  expect(ended.done).toBe(true);
  expect(controlFirst.value).toStrictEqual(before);
  expect(controlRead.value).toStrictEqual(after);
});
