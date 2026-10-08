import { expect, onTestFinished, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import { buildMockImpChangedEvent } from '../test-utils/build-mock-imp-changed-event';
import { checkpointCollection } from './db/checkpoint-collection';
import { imageCollection } from './db/image-collection';
import { impCollection } from './db/imp-collection';
import { sessionCollection } from './db/session-collection';
import { systemInfoCollection } from './db/system-info-collection';
import { tokenCollection } from './db/token-collection';
import { IMPD_ORIGIN } from './handlers';
import { emitImpdEvent, impdEventListeners } from './impd-events';

test('#imps.list lists the imps in the store, with their dates as dates', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const imp = await impCollection.create({ name: 'web' });
  const listed = await client.imps.list();

  expect(listed).toStrictEqual([{ ...imp, leases: { leases: [], otherCount: 0 } }]);
});

test('#imps.list leaves out the imps outside the patterns of the session', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({ imps: ['dev-*'] });
  await impCollection.create({ name: 'dev-web' });
  await impCollection.create({ name: 'prod' });

  const listed = await client.imps.list();

  expect(listed.map((imp) => imp.name)).toStrictEqual(['dev-web']);
});

test('#imps.get rejects a missing imp with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.imps.get({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    status: 404,
    message: 'imp gone not found',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('#imps.sleep moves the imp to sleeping', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const slept = await client.imps.sleep({ name: 'web' });

  expect(slept.state).toBe('sleeping');
});

test('#imps.sleep refuses a session with the read scope', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({ name: 'viewer', scope: 'read' });
  await impCollection.create({ name: 'web' });

  expect(client.imps.sleep({ name: 'web' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    status: 403,
    message: 'dashboard viewer has scope read; this needs exec',
  });
});

test('#imps.create adds the imp it names', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await client.imps.create({ name: 'box', memoryMib: 512 });

  expect(impCollection.findMany().map((imp) => imp.name)).toStrictEqual(['box']);
});

test('#imps.destroy removes the imp it names', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });
  await impCollection.create({ name: 'db' });
  await client.imps.destroy({ name: 'web' });

  expect(impCollection.findMany().map((imp) => imp.name)).toStrictEqual(['db']);
});

test('#imps.destroy rejects a missing imp with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.imps.destroy({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('#imps.update sets the CPU limit it asks for and keeps the weight', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', cpu: { limit: null, weight: 200 } });

  const updated = await client.imps.update({ name: 'web', cpuLimit: 0.5 });

  expect(updated.cpu).toStrictEqual({ limit: 0.5, weight: 200 });
});

test('#imps.update rejects a missing imp with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.imps.update({ name: 'gone', cpuLimit: 1 })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('#imps.fork adds the imp it names', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });
  await client.imps.fork({ source: 'web', name: 'web2' });

  expect(impCollection.findMany().map((imp) => imp.name)).toStrictEqual(['web', 'web2']);
});

test('#imps.fork gives the new imp the disk of the checkpoint it names', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', diskMib: 4096 });
  await checkpointCollection.create({ imp: 'web', id: 'cp1', diskMib: 2048 });

  const forked = await client.imps.fork({ source: 'web', name: 'web2', checkpoint: 'cp1' });

  expect(forked.diskMib).toBe(2048);
});

test('#imps.fork rejects a missing source with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.imps.fork({ source: 'gone', name: 'web2' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('#imps.fork rejects a missing checkpoint with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  expect(
    client.imps.fork({ source: 'web', name: 'web2', checkpoint: 'cp9' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { kind: 'checkpoint', name: 'cp9' } });
});

test('#imps.fork rejects a name another imp has with CONFLICT', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });
  await impCollection.create({ name: 'web2' });

  expect(client.imps.fork({ source: 'web', name: 'web2' })).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'imp', name: 'web2' },
  });
});

test('#imps.url answers the local URL of the imp', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', url: 'http://web.impd.test/' });

  const url = await client.imps.url({ name: 'web' });

  expect(url).toStrictEqual({
    local: 'http://web.impd.test/',
    https: null,
    public: null,
    service: null,
    tailnet: null,
  });
});

test('#checkpoints.create adds a checkpoint of the disk size of the imp', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', diskMib: 2048 });

  const checkpoint = await client.checkpoints.create({ name: 'web', label: 'v2' });

  expect(checkpoint).toStrictEqual({
    id: expect.toBeString(),
    createdAt: expect.toBeValidDate(),
    diskMib: 2048,
    label: 'v2',
  });
});

test('#checkpoints.create rejects a missing imp with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.checkpoints.create({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('#checkpoints.list lists only the checkpoints of the imp', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const createdAt = new Date('2026-10-01T12:00:00Z');

  await checkpointCollection.create({ imp: 'web', id: 'cp1', createdAt, diskMib: 2048 });
  await checkpointCollection.create({ imp: 'db', id: 'cp2' });

  const listed = await client.checkpoints.list({ name: 'web' });

  expect(listed).toStrictEqual([{ id: 'cp1', createdAt, diskMib: 2048 }]);
});

test('#checkpoints.list rejects a missing imp with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.checkpoints.list({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('#checkpoints.restore rejects a missing checkpoint with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  expect(client.checkpoints.restore({ name: 'web', checkpoint: 'cp9' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'checkpoint', name: 'cp9' },
  });
});

test('#checkpoints.delete removes the checkpoint it names by its label', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });
  await checkpointCollection.create({ imp: 'web', id: 'cp1', label: 'before-upgrade' });
  await client.checkpoints.delete({ name: 'web', checkpoint: 'before-upgrade' });

  expect(checkpointCollection.count()).toBe(0);
});

test('#checkpoints.delete rejects a missing checkpoint with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  expect(client.checkpoints.delete({ name: 'web', checkpoint: 'cp9' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'checkpoint', name: 'cp9' },
  });
});

test('#images.add adds the image it pulls', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const image = await client.images.add({ name: 'node', ref: 'docker.io/library/node:22' });

  expect(image).toStrictEqual({
    id: expect.toBeString(),
    name: 'node',
    ref: 'docker.io/library/node:22',
    digest: expect.toStartWith('sha256:'),
    source: 'oci',
    createdAt: expect.toBeValidDate(),
    sizeBytes: expect.toBeNumber(),
  });
});

test('#images.add names an image pulled without a name after its repository', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const image = await client.images.add({ ref: 'ghcr.io/acme/web-app:1.2' });

  expect(image.name).toBe('web-app');
});

test('#images.add refuses a session limited to some imps', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({ name: 'dev', imps: ['dev-*'] });

  expect(client.images.add({ ref: 'docker.io/library/node:22' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'dashboard dev is limited to some imps; this call is host-wide',
  });
});

test('#images.delete removes the image it names', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await imageCollection.create({ name: 'base' });
  await client.images.delete({ name: 'base' });

  expect(imageCollection.count()).toBe(0);
});

test('#images.delete rejects a missing image with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.images.delete({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'image', name: 'gone' },
  });
});

test('#events.stream streams every imp as a snapshot, then each emitted event', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const imp = await impCollection.create({ name: 'web' });
  const stream = await client.events.stream();

  onTestFinished(() => stream.return(undefined));

  const snapshot = await stream.next();

  const event = buildMockImpChangedEvent({ reason: 'slept', imp: { ...imp, state: 'sleeping' } });

  emitImpdEvent(event);

  const changed = await stream.next();

  expect(snapshot.value).toStrictEqual({
    v: EVENT_VERSION,
    at: expect.toBeValidDate(),
    ev: 'ImpAdded',
    reason: 'snapshot',
    imp: { ...imp },
  });

  expect(changed.value).toStrictEqual(event);
});

test('#events.stream streams the change a lifecycle call makes', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const stream = await client.events.stream();

  onTestFinished(() => stream.return(undefined));

  await stream.next();
  await client.imps.sleep({ name: 'web' });

  const changed = await stream.next();

  expect(changed.value).toMatchObject({
    ev: 'ImpChanged',
    reason: 'slept',
    imp: { name: 'web', state: 'sleeping' },
  });
});

test('#events.stream lets go of its listener once the caller aborts it', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  const controller = new AbortController();

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const stream = await client.events.stream(undefined, { signal: controller.signal });

  await stream.next();

  const listening = impdEventListeners.size;

  controller.abort();

  await waitFor(() => {
    expect(impdEventListeners.size).toBe(0);
  });

  expect(listening).toBe(1);
});

test('#system.info answers the host in the store', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await systemInfoCollection.create({ ramBudgetMib: 4096 });

  const info = await client.system.info();

  expect(info.ramBudgetMib).toBe(4096);
});

test('#system.info answers the same host of default values to each read when the store has none', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const first = await client.system.info();
  const second = await client.system.info();

  expect(second).toStrictEqual(first);
});

test('#tokens.list lists the tokens without their secrets', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  const createdAt = new Date('2026-10-01T12:00:00Z');

  await sessionCollection.create({});
  await tokenCollection.create({ name: 'ci', scope: 'exec', createdAt });

  const listed = await client.tokens.list();

  expect(listed).toStrictEqual([
    { name: 'ci', scope: 'exec', imps: null, sshKeys: [], grantable: [], createdAt },
  ]);
});

test('#tokens.list refuses a session limited to some imps', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({ name: 'dev', imps: ['dev-*'] });

  expect(client.tokens.list()).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'dashboard dev is limited to some imps; this call is host-wide',
  });
});

test('#tokens.create answers the secret of the token it adds', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const created = await client.tokens.create({ name: 'ci', scope: 'exec' });

  const row = tokenCollection.findFirst((query) => query.where({ name: 'ci' }));

  invariant(row);

  expect(created.secret).toBe(row.secret);
});

test('#tokens.create rejects a name another token has with CONFLICT', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await tokenCollection.create({ name: 'ci' });

  expect(client.tokens.create({ name: 'ci', scope: 'exec' })).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'token', name: 'ci' },
  });
});

test('#tokens.update sets the secrets the token may grant', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await tokenCollection.create({ name: 'ci' });

  const updated = await client.tokens.update({ name: 'ci', grantable: ['npm'] });

  expect(updated.grantable).toStrictEqual(['npm']);
});

test('#tokens.update rejects a missing token with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.tokens.update({ name: 'gone', grantable: [] })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'token', name: 'gone' },
  });
});

test('#tokens.delete removes the token it names', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await tokenCollection.create({ name: 'ci' });
  await tokenCollection.create({ name: 'old' });
  await client.tokens.delete({ name: 'old' });

  expect(tokenCollection.findMany().map((token) => token.name)).toStrictEqual(['ci']);
});

test('#tokens.delete rejects a missing token with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.tokens.delete({ name: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'token', name: 'gone' },
  });
});

test('#tokens.delete keeps the other tokens when the token it names is missing', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await tokenCollection.create({ name: 'ci' });

  const deleted = await client.tokens.delete({ name: 'gone' }).then(
    () => 'deleted',
    () => 'refused',
  );

  expect(deleted).toBe('refused');
  expect(tokenCollection.findMany().map((token) => token.name)).toStrictEqual(['ci']);
});

test('#tokens.whoami answers the identity of the session', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({ name: 'dev', scope: 'exec', imps: ['dev-*'] });

  const identity = await client.tokens.whoami();

  expect(identity).toStrictEqual({
    kind: 'dashboard',
    name: 'dev',
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [],
  });
});

test('#imps.list hides image builders', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });
  await impCollection.create({ name: 'build-1', kind: 'builder' });

  const listed = await client.imps.list();

  expect(listed.map((imp) => imp.name)).toStrictEqual(['web']);
});

test('#imps.list shows image builders when asked for them', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'build-1', kind: 'builder' });

  const listed = await client.imps.list({ builders: true });

  expect(listed.map((imp) => imp.name)).toStrictEqual(['build-1']);
});

test('#imps.get answers the imp with the leases the caller sees', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const imp = await impCollection.create({ name: 'web' });
  const got = await client.imps.get({ name: 'web' });

  expect(got).toStrictEqual({ ...imp, leases: { leases: [], otherCount: 0 } });
});

test('#imps.create rejects a name another imp has with CONFLICT', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  expect(client.imps.create({ name: 'web' })).rejects.toMatchObject({
    code: 'CONFLICT',
    status: 409,
    message: 'imp web already exists',
    data: { kind: 'imp', name: 'web' },
  });
});

test('#imps.start boots a stopped imp', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', state: 'stopped' });

  const started = await client.imps.start({ name: 'web' });

  expect(started.state).toBe('running');
});

test('#imps.stop rejects an imp that is still being made with INVALID_STATE', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', state: 'creating' });

  expect(client.imps.stop({ name: 'web' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    status: 409,
    message: 'cannot stop an imp that is creating (allowed: running, sleeping, error)',
    data: { state: 'creating', allowed: ['running', 'sleeping', 'error'] },
  });
});

test('#imps.stop stops a running imp', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const stopped = await client.imps.stop({ name: 'web' });

  expect(stopped.state).toBe('stopped');
});

test('#imps.sleep rejects a stopped imp with INVALID_STATE', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', state: 'stopped' });

  expect(client.imps.sleep({ name: 'web' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    status: 409,
    data: { state: 'stopped', allowed: ['running'] },
  });
});

test('#imps.wake wakes a sleeping imp', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', state: 'sleeping' });

  const woken = await client.imps.wake({ name: 'web' });

  expect(woken.state).toBe('running');
});

test('#imps.wake rejects an imp in error with INVALID_STATE when told not to restart it', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', state: 'error' });

  expect(client.imps.wake({ name: 'web', restartError: false })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'error', allowed: ['running', 'sleeping', 'stopped'] },
  });
});

test('#imps.fork answers the grants it did not copy', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const forked = await client.imps.fork({ source: 'web', name: 'web2' });

  expect(forked.grantsNotCopied).toStrictEqual([]);
});

test('#checkpoints.restore boots the imp from the checkpoint it names', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web', state: 'stopped' });
  await checkpointCollection.create({ imp: 'web', id: 'cp1' });

  const restored = await client.checkpoints.restore({ name: 'web', checkpoint: 'cp1' });

  expect(restored.state).toBe('running');
});

test('#images.list lists the images in the store', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const image = await imageCollection.create({ name: 'base' });
  const listed = await client.images.list();

  expect(listed).toStrictEqual([{ ...image }]);
});

test('#images.add pulls again an image of the name it already has', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await imageCollection.create({ name: 'node', ref: 'docker.io/library/node:20' });
  await client.images.add({ name: 'node', ref: 'docker.io/library/node:22' });

  expect(imageCollection.findMany().map((image) => image.ref)).toStrictEqual([
    'docker.io/library/node:22',
  ]);
});

test('#images.add rejects pulling over a template with CONFLICT', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await imageCollection.create({ name: 'node', source: 'imp' });

  expect(
    client.images.add({ name: 'node', ref: 'docker.io/library/node:22' }),
  ).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image node is a template; make it again from an imp, or pick another name',
    data: { kind: 'image', name: 'node' },
  });
});

test('#images.add makes a template from an imp', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const template = await client.images.add({ name: 'web-tpl', imp: 'web' });

  expect(template).toMatchObject({ name: 'web-tpl', ref: 'imp:web', source: 'imp' });
});

test('#images.add rejects a template from a missing imp with NOT_FOUND', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  expect(client.images.add({ name: 'web-tpl', imp: 'gone' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('#images.add rejects a template over a docker image with CONFLICT', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });
  await imageCollection.create({ name: 'node' });

  expect(client.images.add({ name: 'node', imp: 'web' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image node is a docker image; give the template a name of its own',
    data: { kind: 'image', name: 'node' },
  });
});

test('#images.delete rejects an image an imp uses with CONFLICT', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await imageCollection.create({ name: 'base' });
  await impCollection.create({ name: 'web', image: 'base' });

  expect(client.images.delete({ name: 'base' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image base is used by 1 imp(s)',
    data: { kind: 'image', name: 'base' },
  });
});

test('#events.stream streams an ImpAdded for an imp it makes', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const stream = await client.events.stream();

  onTestFinished(() => stream.return(undefined));

  const pending = stream.next();

  await client.imps.create({ name: 'box' });

  const added = await pending;

  expect(added.value).toMatchObject({ ev: 'ImpAdded', reason: 'created', imp: { name: 'box' } });
});

test('#events.stream streams an ImpRemoved for an imp it destroys', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const stream = await client.events.stream();

  onTestFinished(() => stream.return(undefined));

  await stream.next();
  await client.imps.destroy({ name: 'web' });

  const removed = await stream.next();

  expect(removed.value).toMatchObject({ ev: 'ImpRemoved', imp: { name: 'web' } });
});

test('#events.stream streams a CheckpointAdded for a checkpoint it takes', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });

  const stream = await client.events.stream();

  onTestFinished(() => stream.return(undefined));

  await stream.next();
  await client.checkpoints.create({ name: 'web', label: 'v2' });

  const added = await stream.next();

  expect(added.value).toMatchObject({
    ev: 'CheckpointAdded',
    name: 'web',
    checkpoint: { label: 'v2' },
  });
});

test('#events.stream streams a CheckpointRemoved for a checkpoint it deletes', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});
  await impCollection.create({ name: 'web' });
  await checkpointCollection.create({ imp: 'web', id: 'cp1' });

  const stream = await client.events.stream();

  onTestFinished(() => stream.return(undefined));

  await stream.next();
  await client.checkpoints.delete({ name: 'web', checkpoint: 'cp1' });

  const removed = await stream.next();

  expect(removed.value).toMatchObject({
    ev: 'CheckpointRemoved',
    name: 'web',
    checkpoint: { id: 'cp1' },
  });
});

test('#events.stream snapshots only the imps the patterns of the session allow', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({ imps: ['dev-*'] });
  await impCollection.create({ name: 'prod' });
  await impCollection.create({ name: 'dev-web' });

  const stream = await client.events.stream();

  onTestFinished(() => stream.return(undefined));

  const snapshot = await stream.next();

  expect(snapshot.value).toMatchObject({ ev: 'ImpAdded', imp: { name: 'dev-web' } });
});
