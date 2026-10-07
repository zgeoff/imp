import type { Checkpoint, Identity, Image, Imp, ImpEvent, SystemInfo, Token } from '@imp/api';
import { EVENT_VERSION, impContract } from '@imp/api';
import { ORPCError, implement } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { createImpClient } from '@zgeoff/imp-client';
import { createImpd } from '../lib/impd';
import type { Impd } from '../lib/impd';
import { buildMockIdentity } from './build-mock-identity';
import { buildMockImage } from './build-mock-image';
import { buildMockImp } from './build-mock-imp';
import { buildMockSystemInfo } from './build-mock-system-info';

// An impd in memory behind the real contract: the dashboard's queries go
// through the SDK and oRPC's wire format, dates and errors included.
export interface StubImpd {
  readonly impd: Impd;
  readonly state: StubImpdState;

  // sends an event to every open stream, as impd does after a change
  readonly emitEvent: (event: ImpEvent) => void;
}

interface StubImpdState {
  readonly imps: Imp[];
  readonly images: Image[];
  readonly checkpoints: Map<string, Checkpoint[]>;
  readonly tokens: Token[];

  // who tokens.whoami says the dashboard is
  identity: Identity;

  // procedure paths with their inputs, in call order
  readonly calls: { readonly path: string; readonly input: unknown }[];
  info: SystemInfo;

  // answer every call with impd's 401, as for an ended session
  unauthorized: boolean;

  // calls that named an imp that does not exist
  notFound: number;

  // event streams the dashboard holds open now
  openStreams: number;
}

export function buildStubImpd(): StubImpd {
  const stub: StubImpdState = {
    imps: [],
    images: [],
    checkpoints: new Map(),
    tokens: [],
    identity: buildMockIdentity(),
    calls: [],
    info: buildMockSystemInfo(),
    unauthorized: false,
    notFound: 0,
    openStreams: 0,
  };

  const listeners = new Set<EventListener>();

  const emitEvent = (event: ImpEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const os = implement(impContract);

  const registerCall = (path: string, input: unknown): void => {
    stub.calls.push({ path, input });
  };

  const findImp = (name: string): Imp => {
    const imp = stub.imps.find((candidate) => candidate.name === name);

    if (imp === undefined) {
      stub.notFound += 1;
      throw buildNotFoundError('imp', name);
    }

    return imp;
  };

  // as impd: the checkpoint's id or its label
  const findCheckpoint = (name: string, ref: string): Checkpoint => {
    const checkpoint = (stub.checkpoints.get(name) ?? []).find(
      (candidate) => candidate.id === ref || candidate.label === ref,
    );

    if (checkpoint === undefined) {
      throw buildNotFoundError('checkpoint', ref);
    }

    return checkpoint;
  };

  const setImpState = (path: string, name: string, state: Imp['state']): Imp => {
    registerCall(path, { name });

    const imp = findImp(name);
    const moved = { ...imp, state };

    stub.imps.splice(stub.imps.indexOf(imp), 1, moved);

    return moved;
  };

  const router = os.router({
    imps: {
      create: os.imps.create.handler((context) => {
        registerCall('imps.create', context.input);

        const imp = buildMockImp({ name: context.input.name ?? 'fresh-imp' });

        stub.imps.push(imp);

        return imp;
      }),
      list: os.imps.list.handler(() => stub.imps),
      get: os.imps.get.handler((context) => findImp(context.input.name)),
      destroy: os.imps.destroy.handler((context) => {
        registerCall('imps.destroy', context.input);

        stub.imps.splice(stub.imps.indexOf(findImp(context.input.name)), 1);

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
      resizeDisk: os.imps.resizeDisk.handler((context) => {
        registerCall('imps.resizeDisk', context.input);

        const imp = findImp(context.input.name);
        const resized = { ...imp, diskMib: context.input.diskMib };

        stub.imps.splice(stub.imps.indexOf(imp), 1, resized);

        return resized;
      }),
      update: os.imps.update.handler((context) => {
        registerCall('imps.update', context.input);

        const imp = findImp(context.input.name);

        const updated: Imp = {
          ...imp,
          cpu: {
            limit:
              context.input.cpuLimit === undefined
                ? (imp.cpu?.limit ?? null)
                : context.input.cpuLimit,
            weight: context.input.cpuWeight ?? imp.cpu?.weight ?? 100,
          },
        };

        stub.imps.splice(stub.imps.indexOf(imp), 1, updated);

        return updated;
      }),
      url: os.imps.url.handler((context) => ({
        local: findImp(context.input.name).url,
        https: null,
        public: null,
        service: null,
        tailnet: null,
      })),
      policy: os.imps.policy.handler(() => ({ mode: 'open' as const, allow: [] })),
      setPolicy: os.imps.setPolicy.handler((context) => {
        registerCall('imps.setPolicy', context.input);

        return context.input.policy;
      }),
      expose: os.imps.expose.handler(() => {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'not in the stub' });
      }),
      unexpose: os.imps.unexpose.handler((context) => findImp(context.input.name)),
      fork: os.imps.fork.handler((context) => {
        registerCall('imps.fork', context.input);
        findImp(context.input.source);

        if (context.input.checkpoint !== undefined) {
          findCheckpoint(context.input.source, context.input.checkpoint);
        }

        const imp = buildMockImp({ name: context.input.name });

        stub.imps.push(imp);

        return imp;
      }),
    },
    checkpoints: {
      create: os.checkpoints.create.handler((context) => {
        registerCall('checkpoints.create', context.input);

        const imp = findImp(context.input.name);
        const list = stub.checkpoints.get(context.input.name) ?? [];

        const checkpoint = {
          id: `cp${String(list.length + 1)}`,
          createdAt: new Date(),
          diskMib: imp.diskMib,
          ...(context.input.label !== undefined && { label: context.input.label }),
        };

        stub.checkpoints.set(context.input.name, [...list, checkpoint]);

        return checkpoint;
      }),
      list: os.checkpoints.list.handler((context) => {
        findImp(context.input.name);

        return stub.checkpoints.get(context.input.name) ?? [];
      }),
      restore: os.checkpoints.restore.handler((context) => {
        registerCall('checkpoints.restore', context.input);

        const imp = findImp(context.input.name);

        findCheckpoint(context.input.name, context.input.checkpoint);

        return imp;
      }),
      delete: os.checkpoints.delete.handler((context) => {
        registerCall('checkpoints.delete', context.input);
        findImp(context.input.name);

        const checkpoint = findCheckpoint(context.input.name, context.input.checkpoint);
        const list = stub.checkpoints.get(context.input.name) ?? [];

        stub.checkpoints.set(
          context.input.name,
          list.filter((candidate) => candidate !== checkpoint),
        );

        return {};
      }),
    },

    // the dashboard has no lease views
    leases: {
      acquire: os.leases.acquire.handler(() => {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'not in the stub' });
      }),
      renew: os.leases.renew.handler(() => {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'not in the stub' });
      }),
      release: os.leases.release.handler(() => ({ released: false })),
      list: os.leases.list.handler(() => []),
    },

    // the dashboard has no backup views yet
    backups: {
      run: os.backups.run.handler(() => {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'not in the stub' });
      }),
      list: os.backups.list.handler(() => {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'not in the stub' });
      }),
      restore: os.backups.restore.handler(() => {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'not in the stub' });
      }),
      check: os.backups.check.handler(() => {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'not in the stub' });
      }),
    },
    images: {
      list: os.images.list.handler(() => stub.images),
      add: os.images.add.handler((context) => {
        registerCall('images.add', context.input);

        const input = context.input;

        const image =
          'imp' in input
            ? buildMockImage({ name: input.name, ref: `imp:${input.imp}`, source: 'imp' })
            : buildMockImage({ name: input.name ?? 'added', ref: input.ref });

        stub.images.push(image);

        return image;
      }),
      build: os.images.build.handler(() => {
        throw new ORPCError('INVALID_STATE', { message: 'not in the stub' });
      }),

      // the dashboard adds through images.add
      addStream: os.images.addStream.handler(() => {
        throw new ORPCError('INVALID_STATE', { message: 'not in the stub' });
      }),
      buildStream: os.images.buildStream.handler(() => {
        throw new ORPCError('INVALID_STATE', { message: 'not in the stub' });
      }),
      delete: os.images.delete.handler((context) => {
        registerCall('images.delete', context.input);

        const index = stub.images.findIndex((image) => image.name === context.input.name);

        if (index === -1) {
          throw buildNotFoundError('image', context.input.name);
        }

        stub.images.splice(index, 1);

        return {};
      }),
    },
    exec: {
      ticket: os.exec.ticket.handler(() => {
        throw new ORPCError('INVALID_STATE', { message: 'not in the stub' });
      }),
    },
    sessions: {
      list: os.sessions.list.handler(() => []),
      kill: os.sessions.kill.handler((context) => {
        registerCall('sessions.kill', context.input);

        return {};
      }),

      // the dashboard has no session logs
      logs: os.sessions.logs.handler(() => []),
      readLog: os.sessions.readLog.handler(() => {
        throw new Error('not in the stub');
      }),
      deleteLog: os.sessions.deleteLog.handler(() => {
        throw new Error('not in the stub');
      }),
    },

    // the dashboard has no moves
    moves: {
      prepare: os.moves.prepare.handler(() => {
        throw new Error('not in the stub');
      }),
      facts: os.moves.facts.handler(() => {
        throw new Error('not in the stub');
      }),
      receive: os.moves.receive.handler(() => {
        throw new Error('not in the stub');
      }),
      send: os.moves.send.handler(() => {
        throw new Error('not in the stub');
      }),
      status: os.moves.status.handler(() => {
        throw new Error('not in the stub');
      }),
      reissue: os.moves.reissue.handler(() => {
        throw new Error('not in the stub');
      }),
      resume: os.moves.resume.handler(() => {
        throw new Error('not in the stub');
      }),
      abort: os.moves.abort.handler(() => {
        throw new Error('not in the stub');
      }),
    },

    // the dashboard shows no services yet
    services: {
      list: os.services.list.handler(() => ({ services: [], recorded: true })),
      add: os.services.add.handler(() => {
        throw new Error('not in the stub');
      }),
      remove: os.services.remove.handler(() => {
        throw new Error('not in the stub');
      }),
      restart: os.services.restart.handler(() => {
        throw new Error('not in the stub');
      }),
      logs: os.services.logs.handler(() => {
        throw new Error('not in the stub');
      }),
    },

    // the dashboard shows no secrets yet
    secrets: {
      add: os.secrets.add.handler(() => {
        throw new Error('not in the stub');
      }),
      list: os.secrets.list.handler(() => []),
      refresh: os.secrets.refresh.handler(() => {
        throw new Error('not in the stub');
      }),
      delete: os.secrets.delete.handler(() => ({})),
    },

    // nor networks
    networks: {
      list: os.networks.list.handler(() => []),
      create: os.networks.create.handler(() => {
        throw new Error('not in the stub');
      }),
      delete: os.networks.delete.handler(() => ({})),
      join: os.networks.join.handler(() => {
        throw new Error('not in the stub');
      }),
      leave: os.networks.leave.handler(() => {
        throw new Error('not in the stub');
      }),
      warnings: os.networks.warnings.handler(() => []),
    },
    grants: {
      add: os.grants.add.handler(() => ({})),
      delete: os.grants.delete.handler(() => ({})),
      list: os.grants.list.handler(() => []),
    },
    audit: {
      list: os.audit.list.handler(() => []),
      calls: os.audit.calls.handler(() => []),
    },
    events: {
      stream: os.events.stream.handler((context) =>
        openStream(
          (listener) => {
            listeners.add(listener);

            stub.openStreams += 1;

            return () => {
              listeners.delete(listener);

              stub.openStreams -= 1;
            };
          },
          stub.imps,
          context.signal,
        ),
      ),
    },
    system: {
      info: os.system.info.handler(() => stub.info),
      gc: os.system.gc.handler((context) => ({
        dryRun: context.input.dryRun ?? false,
        dropped: [],
        kept: [],
      })),
      copyDatabase: os.system.copyDatabase.handler(() => {
        throw new ORPCError('PRECONDITION_FAILED', { message: 'not in the stub' });
      }),
    },

    // the dashboard shows no OAuth page yet
    oauth: {
      clients: {
        list: os.oauth.clients.list.handler(() => []),
        add: os.oauth.clients.add.handler((context) => ({
          name: context.input.name,
          clientId: 'impc_stub',
          redirectUris: context.input.redirectUris,
          createdAt: NOW,
        })),
        update: os.oauth.clients.update.handler((context) => ({
          name: context.input.name,
          clientId: 'impc_stub',
          redirectUris: context.input.redirectUris,
          createdAt: NOW,
        })),
        delete: os.oauth.clients.delete.handler(() => ({})),
      },
      grants: {
        list: os.oauth.grants.list.handler(() => []),
        delete: os.oauth.grants.delete.handler(() => ({})),
      },
      approvals: {
        get: os.oauth.approvals.get.handler(() => ({
          client: 'stub',
          redirectUri: 'https://client.test/callback',
          requestedScope: 'read' as const,
          requestedAt: NOW,
          expiresAt: NOW,
        })),
        approve: os.oauth.approvals.approve.handler(() => ({})),
      },
    },
    tokens: {
      list: os.tokens.list.handler(() => stub.tokens),
      create: os.tokens.create.handler((context) => {
        registerCall('tokens.create', context.input);

        const token: Token = {
          name: context.input.name,
          scope: context.input.scope,
          imps: context.input.imps ?? null,
          sshKeys: [],
          grantable: context.input.grantable ?? [],
          createdAt: NOW,
        };

        stub.tokens.push(token);

        return { token, secret: `imp_stub.${context.input.name}-secret` };
      }),
      update: os.tokens.update.handler((context) => {
        registerCall('tokens.update', context.input);

        const index = stub.tokens.findIndex((token) => token.name === context.input.name);
        const found = stub.tokens[index];

        if (found === undefined) {
          throw buildNotFoundError('token', context.input.name);
        }

        const token: Token = { ...found, grantable: context.input.grantable };

        stub.tokens[index] = token;

        return token;
      }),
      delete: os.tokens.delete.handler((context) => {
        registerCall('tokens.delete', context.input);

        const index = stub.tokens.findIndex((token) => token.name === context.input.name);

        if (index === -1) {
          throw buildNotFoundError('token', context.input.name);
        }

        stub.tokens.splice(index, 1);

        return {};
      }),
      addKey: os.tokens.addKey.handler((context) => {
        registerCall('tokens.addKey', context.input);

        return { fingerprint: 'SHA256:stub', type: 'ssh-ed25519', comment: '' };
      }),
      removeKey: os.tokens.removeKey.handler((context) => {
        registerCall('tokens.removeKey', context.input);

        return {};
      }),
      whoami: os.tokens.whoami.handler(() => stub.identity),
    },
  });

  const handler = new RPCHandler(router);

  const client = createImpClient({
    url: 'http://impd.test',
    fetch: async (request) => {
      if (stub.unauthorized) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      const handled = await handler.handle(request, { prefix: '/rpc', context: {} });

      return handled.matched ? handled.response : new Response('not found', { status: 404 });
    },
  });

  return { impd: createImpd(client), state: stub, emitEvent };
}

const NOW = new Date('2026-10-02T12:00:00Z');

type EventListener = (event: ImpEvent) => void;

// the snapshot, then each event emitted until the dashboard lets go
async function* openStream(
  subscribe: (listener: EventListener) => () => void,
  imps: readonly Imp[],
  signal: AbortSignal | undefined,
): AsyncGenerator<ImpEvent> {
  const queue: ImpEvent[] = imps.map((imp) => ({
    v: EVENT_VERSION,
    at: NOW,
    ev: 'ImpAdded',
    reason: 'snapshot',
    imp,
  }));

  const state = { wake: (): void => {} };

  const handleEvent = (event: ImpEvent): void => {
    queue.push(event);
    state.wake();
  };

  const stopStream = (): void => {
    state.wake();
  };

  const unsubscribe = subscribe(handleEvent);

  signal?.addEventListener('abort', stopStream);

  try {
    for (;;) {
      if (signal?.aborted === true) {
        return;
      }

      const next = queue.shift();

      if (next !== undefined) {
        yield next;
        continue;
      }

      const waiting = Promise.withResolvers<undefined>();

      state.wake = () => {
        waiting.resolve(undefined);
      };

      await waiting.promise;
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', stopStream);
  }
}

// impd's NOT_FOUND (packages/daemon api-errors.ts)
function buildNotFoundError(kind: 'imp' | 'image' | 'checkpoint' | 'token', name: string) {
  return new ORPCError('NOT_FOUND', { message: `${kind} ${name} not found`, data: { kind, name } });
}
