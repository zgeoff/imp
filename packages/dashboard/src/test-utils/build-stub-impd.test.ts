import { expect, onTestFinished, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import { isUnauthorized } from '../lib/build-query-client';
import { buildMockImp } from './build-mock-imp';
import { buildMockImpChangedEvent } from './build-mock-imp-changed-event';
import { buildStubImpd } from './build-stub-impd';

test('it lists the imps in its state, with their dates as dates', async () => {
  const stub = buildStubImpd();
  const imp = buildMockImp({ name: 'web' });

  stub.state.imps.push(imp);

  const listed = await stub.impd.client.imps.list();

  expect(listed).toStrictEqual([imp]);
});

test('it rejects a call that names a missing imp with NOT_FOUND and counts it', () => {
  const stub = buildStubImpd();

  expect(stub.impd.client.imps.get({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    status: 404,
    message: 'there is no imp named gone',
  });

  expect(stub.state.notFound).toBe(1);
});

test('it answers every call with a 401 the dashboard reads as an ended session', () => {
  const stub = buildStubImpd();

  stub.state.unauthorized = true;

  expect(stub.impd.client.imps.list()).rejects.toSatisfy(isUnauthorized);
});

test('it records each changing call with its input, in call order', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  await stub.impd.client.imps.sleep({ name: 'web' });
  await stub.impd.client.imps.wake({ name: 'web' });

  expect(stub.state.calls).toStrictEqual([
    { path: 'imps.sleep', input: { name: 'web' } },
    { path: 'imps.wake', input: { name: 'web' } },
  ]);
});

test('it moves an imp to the state a lifecycle call asks for', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web', state: 'running' }));

  const slept = await stub.impd.client.imps.sleep({ name: 'web' });

  expect(slept.state).toBe('sleeping');
});

test('it answers tokens.create with a secret named after the token', async () => {
  const stub = buildStubImpd();

  const created = await stub.impd.client.tokens.create({ name: 'ci', scope: 'exec' });

  expect(created.secret).toBe('imp_stub.ci-secret');
});

test('it streams every imp as a snapshot, then each emitted event', async () => {
  const stub = buildStubImpd();
  const imp = buildMockImp({ name: 'web' });
  const event = buildMockImpChangedEvent({ reason: 'slept', imp: { name: 'web' } });

  stub.state.imps.push(imp);

  const stream = await stub.impd.client.events.stream();

  onTestFinished(() => stream.return(undefined));

  const snapshot = await stream.next();

  stub.emitEvent(event);

  const changed = await stream.next();

  expect([snapshot.value, changed.value]).toStrictEqual([
    { v: EVENT_VERSION, at: expect.toBeValidDate(), ev: 'ImpAdded', reason: 'snapshot', imp },
    event,
  ]);
});

test('it counts the event streams held open', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  const stream = await stub.impd.client.events.stream();

  onTestFinished(() => stream.return(undefined));

  await stream.next();

  expect(stub.state.openStreams).toBe(1);
});
