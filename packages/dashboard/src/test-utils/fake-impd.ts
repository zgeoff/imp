import type { Checkpoint, Image, Imp, SystemInfo } from '@imp/api';
import { impContract } from '@imp/api';
import { ORPCError, implement } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { createImpClient } from '@zgeoff/imp-client';
import { createImpd } from '../lib/impd';
import type { Impd } from '../lib/impd';

// An impd in memory behind the real contract: the dashboard's queries go
// through the SDK and oRPC's wire format, dates and errors included.
export interface FakeImpd {
  readonly impd: Impd;
  readonly state: FakeImpdState;
}

interface FakeImpdState {
  readonly imps: Imp[];
  readonly images: Image[];
  readonly checkpoints: Map<string, Checkpoint[]>;

  // procedure paths with their inputs, in call order
  readonly calls: { readonly path: string; readonly input: unknown }[];
  info: SystemInfo;

  // answer every call with impd's 401, as for an ended session
  unauthorized: boolean;
}

export function createFakeImpd(): FakeImpd {
  const fake: FakeImpdState = {
    imps: [],
    images: [],
    checkpoints: new Map(),
    calls: [],
    info: buildSystemInfo(),
    unauthorized: false,
  };

  const os = implement(impContract);

  const registerCall = (path: string, input: unknown): void => {
    fake.calls.push({ path, input });
  };

  const findImp = (name: string): Imp => {
    const imp = fake.imps.find((candidate) => candidate.name === name);

    if (imp === undefined) {
      throw new ORPCError('NOT_FOUND', { message: `there is no imp named ${name}` });
    }

    return imp;
  };

  const setImpState = (path: string, name: string, state: Imp['state']): Imp => {
    registerCall(path, { name });

    const imp = findImp(name);
    const moved = { ...imp, state };

    fake.imps.splice(fake.imps.indexOf(imp), 1, moved);

    return moved;
  };

  const router = os.router({
    imps: {
      create: os.imps.create.handler((context) => {
        registerCall('imps.create', context.input);

        const imp = buildImp({ name: context.input.name ?? 'fresh-imp' });

        fake.imps.push(imp);

        return imp;
      }),
      list: os.imps.list.handler(() => fake.imps),
      get: os.imps.get.handler((context) => findImp(context.input.name)),
      destroy: os.imps.destroy.handler((context) => {
        registerCall('imps.destroy', context.input);

        fake.imps.splice(fake.imps.indexOf(findImp(context.input.name)), 1);

        return {};
      }),
      start: os.imps.start.handler((context) =>
        setImpState('imps.start', context.input.name, 'running'),
      ),
      stop: os.imps.stop.handler((context) =>
        setImpState('imps.stop', context.input.name, 'stopped'),
      ),
      sleep: os.imps.sleep.handler((context) =>
        setImpState('imps.sleep', context.input.name, 'sleeping'),
      ),
      wake: os.imps.wake.handler((context) =>
        setImpState('imps.wake', context.input.name, 'running'),
      ),
      hold: os.imps.hold.handler((context) => findImp(context.input.name)),
      url: os.imps.url.handler((context) => ({
        local: findImp(context.input.name).url,
        tailnet: null,
      })),
      fork: os.imps.fork.handler((context) => {
        registerCall('imps.fork', context.input);

        const imp = buildImp({ name: context.input.name });

        fake.imps.push(imp);

        return imp;
      }),
    },
    checkpoints: {
      create: os.checkpoints.create.handler((context) => {
        registerCall('checkpoints.create', context.input);

        const list = fake.checkpoints.get(context.input.name) ?? [];

        const checkpoint = {
          id: `cp${String(list.length + 1)}`,
          createdAt: new Date(),
          ...(context.input.label !== undefined && { label: context.input.label }),
        };

        fake.checkpoints.set(context.input.name, [...list, checkpoint]);

        return checkpoint;
      }),
      list: os.checkpoints.list.handler(
        (context) => fake.checkpoints.get(context.input.name) ?? [],
      ),
      restore: os.checkpoints.restore.handler((context) => {
        registerCall('checkpoints.restore', context.input);

        return findImp(context.input.name);
      }),
      delete: os.checkpoints.delete.handler((context) => {
        registerCall('checkpoints.delete', context.input);

        return {};
      }),
    },
    images: {
      list: os.images.list.handler(() => fake.images),
      add: os.images.add.handler((context) => {
        registerCall('images.add', context.input);

        return buildImage({ name: context.input.name ?? 'added', ref: context.input.ref });
      }),
      build: os.images.build.handler(() => {
        throw new ORPCError('INVALID_STATE', { message: 'not in the fake' });
      }),
      delete: os.images.delete.handler((context) => {
        registerCall('images.delete', context.input);

        return {};
      }),
    },
    exec: {
      ticket: os.exec.ticket.handler(() => {
        throw new ORPCError('INVALID_STATE', { message: 'not in the fake' });
      }),
    },
    system: {
      info: os.system.info.handler(() => fake.info),
    },
  });

  const handler = new RPCHandler(router);

  const client = createImpClient({
    url: 'http://impd.test',
    fetch: async (request) => {
      if (fake.unauthorized) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      const handled = await handler.handle(request, { prefix: '/rpc', context: {} });

      return handled.matched ? handled.response : new Response('not found', { status: 404 });
    },
  });

  return { impd: createImpd(client), state: fake };
}

const NOW = new Date('2026-10-02T12:00:00Z');

export function buildImp(overrides: Partial<Imp> & { readonly name: string }): Imp {
  return {
    id: `id-${overrides.name}`,
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 2048,
    ip: '10.66.0.2',
    slot: 0,
    port: 20_000,
    httpPort: 8080,
    url: `http://${overrides.name}.imp.localhost:7080`,
    createdAt: NOW,
    lastActiveAt: NOW,
    ...overrides,
  };
}

export function buildImage(overrides: Partial<Image> & { readonly name: string }): Image {
  return {
    id: `image-${overrides.name}`,
    ref: `docker.io/library/${overrides.name}:latest`,
    digest: 'sha256:0',
    createdAt: NOW,
    sizeBytes: 512 * 1024 * 1024,
    ...overrides,
  };
}

function buildSystemInfo(): SystemInfo {
  return {
    version: '0.0.0',
    ramBudgetMib: 4096,
    ramUsedMib: 1024,
    ramReservedMib: 512,
    ramCommittedMib: 6144,
    awakeCount: 1,
    impCount: 2,
    firecrackerVersion: 'v1.17.0',
    guestKernel: { version: null, sha256: '0' },
    systemDrive: { sha256: '0' },
    tailscale: { enabled: false, state: null, hostname: null, ip: null },
  };
}
