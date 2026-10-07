import { expect, onTestFinished, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import { waitFor } from '@imp/test-utils/wait-for';
import { isUnauthorized } from '../lib/build-query-client';
import { buildMockCheckpoint } from './build-mock-checkpoint';
import { buildMockImage } from './build-mock-image';
import { buildMockImp } from './build-mock-imp';
import { buildMockImpChangedEvent } from './build-mock-imp-changed-event';
import { buildMockToken } from './build-mock-token';
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
    message: 'imp gone not found',
  });

  expect(stub.state.notFound).toBe(1);
});

test('it answers a call with a 401 the dashboard reads as an ended session while unauthorized', () => {
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

test('it stops counting an event stream once the dashboard aborts it', async () => {
  const stub = buildStubImpd();

  const controller = new AbortController();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  const stream = await stub.impd.client.events.stream(undefined, { signal: controller.signal });

  await stream.next();

  controller.abort();

  await waitFor(() => {
    expect(stub.state.openStreams).toBe(0);
  });
});

test('it adds the imp that imps.create names', async () => {
  const stub = buildStubImpd();

  await stub.impd.client.imps.create({ name: 'box' });

  expect(stub.state.imps.map((imp) => imp.name)).toStrictEqual(['box']);
});

test('it removes the imp that imps.destroy names', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }), buildMockImp({ name: 'db' }));

  await stub.impd.client.imps.destroy({ name: 'web' });

  expect(stub.state.imps.map((imp) => imp.name)).toStrictEqual(['db']);
});

test('it sets the CPU limit that imps.update asks for and keeps the weight', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web', cpu: { limit: null, weight: 200 } }));

  await stub.impd.client.imps.update({ name: 'web', cpuLimit: 0.5 });

  expect(stub.state.imps[0]?.cpu).toStrictEqual({ limit: 0.5, weight: 200 });
});

test('it adds the imp that imps.fork names', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  await stub.impd.client.imps.fork({ source: 'web', name: 'web2' });

  expect(stub.state.imps.map((imp) => imp.name)).toStrictEqual(['web', 'web2']);
});

test('it adds a checkpoint of the disk size of the imp on checkpoints.create', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web', diskMib: 2048 }));

  await stub.impd.client.checkpoints.create({ name: 'web', label: 'v2' });

  expect(stub.state.checkpoints.get('web')).toStrictEqual([
    { id: 'cp1', createdAt: expect.toBeValidDate(), diskMib: 2048, label: 'v2' },
  ]);
});

test('it lists the checkpoints of the imp on checkpoints.list', async () => {
  const stub = buildStubImpd();
  const checkpoint = buildMockCheckpoint({ id: 'cp1' });

  stub.state.imps.push(buildMockImp({ name: 'web' }));
  stub.state.checkpoints.set('web', [checkpoint]);

  const listed = await stub.impd.client.checkpoints.list({ name: 'web' });

  expect(listed).toStrictEqual([checkpoint]);
});

test('it removes the checkpoint that checkpoints.delete names', async () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }));
  stub.state.checkpoints.set('web', [buildMockCheckpoint({ id: 'cp1' })]);

  await stub.impd.client.checkpoints.delete({ name: 'web', checkpoint: 'cp1' });

  expect(stub.state.checkpoints.get('web')).toStrictEqual([]);
});

test('it adds the image that images.add pulls', async () => {
  const stub = buildStubImpd();

  await stub.impd.client.images.add({ name: 'node', ref: 'docker.io/library/node:22' });

  expect(stub.state.images).toStrictEqual([
    {
      id: expect.toBeString(),
      name: 'node',
      ref: 'docker.io/library/node:22',
      digest: expect.toBeString(),
      source: 'oci',
      createdAt: expect.toBeValidDate(),
      sizeBytes: expect.toBeNumber(),
    },
  ]);
});

test('it removes the image that images.delete names', async () => {
  const stub = buildStubImpd();

  stub.state.images.push(buildMockImage({ name: 'base' }));

  await stub.impd.client.images.delete({ name: 'base' });

  expect(stub.state.images).toStrictEqual([]);
});

test('it sets the secrets that tokens.update grants', async () => {
  const stub = buildStubImpd();

  stub.state.tokens.push(buildMockToken({ name: 'ci', grantable: [] }));

  await stub.impd.client.tokens.update({ name: 'ci', grantable: ['npm'] });

  expect(stub.state.tokens[0]?.grantable).toStrictEqual(['npm']);
});

test('it removes the token that tokens.delete names', async () => {
  const stub = buildStubImpd();

  stub.state.tokens.push(buildMockToken({ name: 'ci' }), buildMockToken({ name: 'old' }));

  await stub.impd.client.tokens.delete({ name: 'old' });

  expect(stub.state.tokens.map((token) => token.name)).toStrictEqual(['ci']);
});

test('it rejects imps.destroy of a missing imp with NOT_FOUND', () => {
  const stub = buildStubImpd();

  expect(stub.impd.client.imps.destroy({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('it rejects imps.update of a missing imp with NOT_FOUND', () => {
  const stub = buildStubImpd();

  expect(stub.impd.client.imps.update({ name: 'gone', cpuLimit: 1 })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('it rejects imps.fork of a missing source with NOT_FOUND', () => {
  const stub = buildStubImpd();

  expect(stub.impd.client.imps.fork({ source: 'gone', name: 'web2' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('it rejects imps.fork of a missing checkpoint with NOT_FOUND', () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  expect(
    stub.impd.client.imps.fork({ source: 'web', name: 'web2', checkpoint: 'cp9' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { kind: 'checkpoint', name: 'cp9' } });
});

test('it rejects checkpoints.create of a missing imp with NOT_FOUND', () => {
  const stub = buildStubImpd();

  expect(stub.impd.client.checkpoints.create({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('it rejects checkpoints.list of a missing imp with NOT_FOUND', () => {
  const stub = buildStubImpd();

  expect(stub.impd.client.checkpoints.list({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('it rejects checkpoints.restore of a missing checkpoint with NOT_FOUND', () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  expect(
    stub.impd.client.checkpoints.restore({ name: 'web', checkpoint: 'cp9' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { kind: 'checkpoint', name: 'cp9' } });
});

test('it rejects checkpoints.delete of a missing checkpoint with NOT_FOUND', () => {
  const stub = buildStubImpd();

  stub.state.imps.push(buildMockImp({ name: 'web' }));

  expect(
    stub.impd.client.checkpoints.delete({ name: 'web', checkpoint: 'cp9' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { kind: 'checkpoint', name: 'cp9' } });
});

test('it rejects images.delete of a missing image with NOT_FOUND', () => {
  const stub = buildStubImpd();

  expect(stub.impd.client.images.delete({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'image', name: 'gone' },
  });
});

test('it rejects tokens.update of a missing token with NOT_FOUND', () => {
  const stub = buildStubImpd();

  expect(stub.impd.client.tokens.update({ name: 'gone', grantable: [] })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'token', name: 'gone' },
  });
});

test('it rejects tokens.delete of a missing token with NOT_FOUND and keeps the others', () => {
  const stub = buildStubImpd();

  stub.state.tokens.push(buildMockToken({ name: 'ci' }));

  expect(stub.impd.client.tokens.delete({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'token', name: 'gone' },
  });

  expect(stub.state.tokens.map((token) => token.name)).toStrictEqual(['ci']);
});
