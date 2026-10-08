import { expect, onTestFinished, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
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

test('#openImpdEventStream wakes a waiting reader for an event emitted later', async () => {
  const stream = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    () => [],
    undefined,
  );

  onTestFinished(() => stream.return(undefined));

  const pending = stream.next();
  const event = buildMockImpChangedEvent({ imp: { name: 'web' } });

  await Promise.resolve();

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

  const stream = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    () => [],
    controller.signal,
  );

  const pending = stream.next();

  await Promise.resolve();

  const listening = impdEventListeners.size;

  controller.abort();

  const ended = await pending;

  expect(listening).toBe(1);
  expect(ended.done).toBe(true);
  expect(impdEventListeners.size).toBe(0);
});

test('#openImpdEventStream ends at a logout', async () => {
  const stream = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 60_000) },
    () => [],
    undefined,
  );

  onTestFinished(() => stream.return(undefined));

  const pending = stream.next();

  await Promise.resolve();

  impdLogouts.logOut();

  const ended = await pending;

  expect(ended.done).toBe(true);
});

// the session's expiry runs on impd's real timer, so this one is 50 ms off
test('#openImpdEventStream ends when the session expires', async () => {
  const stream = openImpdEventStream(
    { imps: null, expiresAt: new Date(Date.now() + 50) },
    () => [],
    undefined,
  );

  onTestFinished(() => stream.return(undefined));

  const ended = await stream.next();

  expect(ended.done).toBe(true);
});
