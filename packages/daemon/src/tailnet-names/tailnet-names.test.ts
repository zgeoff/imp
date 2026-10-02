import { expect, test } from 'bun:test';
import { findImpByName } from '../db/imps';
import { setupImpTest } from '../imps/test-imps';
import { deriveSlotAddress } from '../net/addressing';
import { listServeEntries } from './service-serve';
import type { ServiceServe } from './service-serve';
import type { ServicesApi, TailnetService } from './services-api';
import { SERVICE_TAG, createTailnetNames } from './tailnet-names';

const HOST = 'host-a';

// the Services API as a map, with a log of each call
function createFakeApi() {
  const services = new Map<string, TailnetService>();

  const calls: string[] = [];

  const state: { down: string | null; afterList: (() => void) | null } = {
    down: null,
    afterList: null,
  };

  const requireUp = (): void => {
    if (state.down !== null) {
      throw new Error(state.down);
    }
  };

  const api: ServicesApi = {
    listServices: () => {
      calls.push('list');

      requireUp();

      const listed = [...services.values()];

      state.afterList?.();

      return Promise.resolve(listed);
    },
    readService: (name) => {
      calls.push(`read ${name}`);

      requireUp();

      return Promise.resolve(services.get(name) ?? null);
    },
    writeService: (definition) => {
      calls.push(`write ${definition.name}`);

      requireUp();

      services.set(definition.name, definition);

      return Promise.resolve();
    },
    deleteService: (name) => {
      calls.push(`delete ${name}`);

      requireUp();

      services.delete(name);

      return Promise.resolve();
    },
  };

  return { api, services, calls, state };
}

// `record` writes to the fake API's log, so one list shows the order of both
function createFakeServe(record: (call: string) => void) {
  const served = new Map<string, readonly string[]>();

  const serve: ServiceServe = {
    readServed: () => Promise.resolve(new Map(served)),
    writeServe: (service, target) => {
      record(`serve ${service} ${target}`);

      served.set(service, listServeEntries(target));

      return Promise.resolve();
    },
    clearServe: (service) => {
      record(`clear ${service}`);

      served.delete(service);

      return Promise.resolve();
    },
  };

  return { serve, served };
}

async function setupNames(hostId = HOST) {
  const ctx = await setupImpTest();

  await ctx.createTestImage('base');

  const fake = createFakeApi();

  const serve = createFakeServe((call) => {
    fake.calls.push(call);
  });

  const logs: string[] = [];

  const buildNames = (id: string) =>
    createTailnetNames({
      config: { prefix: '', oauthFile: '/unused' },
      hostId: id,
      db: ctx.db,
      api: fake.api,
      serve: serve.serve,
      findPort: (slot) => deriveSlotAddress(slot, ctx.config).tailnetPort,
      isImpPresent: async (name) => (await findImpByName(ctx.db, name)) !== undefined,
      readSuffix: () => Promise.resolve('tail1234.ts.net'),
      log: (line) => {
        logs.push(line);
      },
    });

  return { ...ctx, fake, serve, logs, names: buildNames(hostId), buildNames };
}

test('each imp gets a service of this host’s, served to its own port', async () => {
  await using ctx = await setupNames();

  const imp = await ctx.imps.createImp({ name: 'box' });

  await ctx.names.runSync();

  const port = deriveSlotAddress(imp.slot, ctx.config).tailnetPort;

  expect(ctx.fake.services.get('svc:box')).toEqual({
    name: 'svc:box',
    comment: `imp host ${HOST}`,
    ports: ['tcp:80', 'tcp:443'],
    tags: [SERVICE_TAG],
  });

  expect(ctx.fake.calls).toEqual([
    'list',
    'read svc:box',
    'write svc:box',
    `serve svc:box http://127.0.0.1:${String(port)}`,
  ]);

  expect(ctx.names.readUrl('box')).toBe('https://box.tail1234.ts.net');
  expect(ctx.names.readStatus()).toEqual({ live: 1, failed: [] });

  // a second pass finds it all in place
  ctx.fake.calls.length = 0;

  await ctx.names.runSync();

  expect(ctx.fake.calls).toEqual(['list']);
});

test('a service by that name that is not this host’s is never written', async () => {
  await using ctx = await setupNames();

  ctx.fake.services.set('svc:box', { name: 'svc:box', comment: 'the web team', tags: [] });

  ctx.fake.services.set('svc:web', {
    name: 'svc:web',
    comment: 'imp host host-b',
    tags: [SERVICE_TAG],
  });

  await ctx.imps.createImp({ name: 'box' });
  await ctx.imps.createImp({ name: 'web' });
  await ctx.names.runSync();

  expect(ctx.fake.calls.filter((call) => call.startsWith('write'))).toEqual([]);
  expect(ctx.fake.services.get('svc:box')?.comment).toBe('the web team');
  expect(ctx.names.readUrl('box')).toBeNull();

  expect(ctx.names.readStatus().failed).toEqual([
    { name: 'box', error: 'svc:box exists and this host does not own it' },
    { name: 'web', error: 'svc:web exists and this host does not own it' },
  ]);
});

test('a service that appears after the list is read again before any write', async () => {
  await using ctx = await setupNames();

  await ctx.imps.createImp({ name: 'box' });

  ctx.fake.state.afterList = () => {
    ctx.fake.services.set('svc:box', { name: 'svc:box', comment: 'someone else' });
  };

  await ctx.names.runSync();

  expect(ctx.fake.calls).toEqual(['list', 'read svc:box']);
  expect(ctx.fake.services.get('svc:box')?.comment).toBe('someone else');
});

test('a destroyed imp’s service is cleared, then deleted; others stay', async () => {
  await using ctx = await setupNames();

  await ctx.imps.createImp({ name: 'box' });
  await ctx.names.runSync();

  // another host's, someone else's, and one of ours untagged by hand
  ctx.fake.services.set('svc:other', {
    name: 'svc:other',
    comment: 'imp host host-b',
    tags: [SERVICE_TAG],
  });

  ctx.fake.services.set('svc:team', { name: 'svc:team', comment: 'the web team' });
  ctx.fake.services.set('svc:untagged', { name: 'svc:untagged', comment: `imp host ${HOST}` });

  await ctx.imps.destroyImp('box');

  ctx.fake.calls.length = 0;

  await ctx.names.runSync();

  expect(ctx.fake.calls).toEqual(['list', 'clear svc:box', 'delete svc:box']);

  expect([...ctx.fake.services.keys()].toSorted()).toEqual([
    'svc:other',
    'svc:team',
    'svc:untagged',
  ]);

  expect(ctx.names.readStatus()).toEqual({ live: 0, failed: [] });
});

test('a second host never removes the first one’s services', async () => {
  await using ctx = await setupNames();

  await ctx.imps.createImp({ name: 'box' });
  await ctx.names.runSync();
  await ctx.imps.destroyImp('box');

  const other = ctx.buildNames('host-b');

  await other.runSync();

  expect(ctx.fake.services.has('svc:box')).toBeTrue();
});

test('an API outage fails every name, and the next pass brings them back', async () => {
  await using ctx = await setupNames();

  await ctx.imps.createImp({ name: 'box' });

  ctx.fake.state.down = 'Tailscale GET /tailnet/-/services: 503 unavailable';

  await ctx.names.runSync();
  await ctx.names.runSync();

  expect(ctx.names.readStatus().failed).toEqual([
    { name: 'box', error: 'Tailscale GET /tailnet/-/services: 503 unavailable' },
  ]);

  expect(ctx.logs.filter((line) => line.includes('503'))).toHaveLength(1);

  ctx.fake.state.down = null;

  await ctx.names.runSync();

  expect(ctx.names.readStatus()).toEqual({ live: 1, failed: [] });
});

test('a name a device holds fails that imp only, and the create stands', async () => {
  await using ctx = await setupNames();

  const write = ctx.fake.api.writeService;

  ctx.fake.api = {
    ...ctx.fake.api,
    writeService: (definition) =>
      definition.name === 'svc:laptop'
        ? Promise.reject(
            new Error(
              'Tailscale PUT /tailnet/-/services/svc%3Alaptop: 400 name in use by a machine',
            ),
          )
        : write(definition),
  };

  const laptop = await ctx.imps.createImp({ name: 'laptop' });

  await ctx.imps.createImp({ name: 'box' });

  const names = ctx.buildNames(HOST);

  await names.runSync();

  expect(laptop.state).toBe('running');

  expect(names.readStatus()).toEqual({
    live: 1,
    failed: [
      {
        name: 'laptop',
        error: 'Tailscale PUT /tailnet/-/services/svc%3Alaptop: 400 name in use by a machine',
      },
    ],
  });
});

test('serve config for a service gone from the tailnet is cleared', async () => {
  await using ctx = await setupNames();

  ctx.serve.served.set('svc:gone', listServeEntries('http://127.0.0.1:20005'));

  await ctx.names.runSync();

  expect(ctx.fake.calls).toEqual(['list', 'clear svc:gone']);
});

test('imp url shows the name once it is live, before the local URL', async () => {
  const live = new Set<string>();

  await using ctx = await setupImpTest({
    readServiceUrl: (name) => (live.has(name) ? `https://${name}.tail1234.ts.net` : null),
  });

  await ctx.createTestImage('base');
  await ctx.imps.createImp({ name: 'box' });

  const before = await ctx.imps.readUrls('box');

  live.add('box');

  const after = await ctx.imps.readUrls('box');

  expect(before.service).toBeNull();
  expect(after.service).toBe('https://box.tail1234.ts.net');
});
