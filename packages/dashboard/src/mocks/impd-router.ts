import type { Checkpoint, Identity, Imp, ImpChangeReason, Token } from '@imp/api';
import { EVENT_VERSION, impContract, isImpAllowed } from '@imp/api';
import {
  buildConflictError,
  buildForbiddenError,
  buildNotFoundError,
} from '@imp/daemon/src/api-errors';
import { checkAccess, findAccess } from '@imp/daemon/src/auth/access-policy';
import type { Caller } from '@imp/daemon/src/auth/caller';
import { deriveImageName } from '@imp/daemon/src/images/image-naming';
import { implement } from '@orpc/server';
import { checkpointCollection } from './db/checkpoint-collection';
import { imageCollection } from './db/image-collection';
import { impCollection } from './db/imp-collection';
import { SystemInfoRowSchema, systemInfoCollection } from './db/system-info-collection';
import { tokenCollection } from './db/token-collection';
import { emitImpdEvent, openImpdEventStream } from './impd-events';

// what each call runs as: the browser's dashboard session
interface ImpdRouterContext {
  readonly session: Identity;
}

// Every call passes impd's own access check (packages/daemon
// auth/access-policy.ts) first, so a session's scope and imp patterns refuse
// a call as impd does.
const os = implement(impContract)
  .$context<ImpdRouterContext>()
  .use(async (options, input) => {
    const refusal = await checkAccess(
      findAccess(options.path.join('.')),
      toCaller(options.context.session),
      input,

      // the dashboard grants no secrets
      () => Promise.resolve(null),
    );

    if (refusal !== null) {
      throw buildForbiddenError(refusal.message, refusal.reason);
    }

    return options.next();
  });

// The procedures the dashboard calls, over the collections in ./db. A
// procedure left out answers 404, so a page that starts to call one fails
// its tests until it is added here.
export const impdRouter = {
  imps: {
    create: os.imps.create.handler(async (options) => {
      const input = options.input;

      const imp = await impCollection.create({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.image !== undefined && { image: input.image }),
        ...(input.vcpus !== undefined && { vcpus: input.vcpus }),
        ...(input.memoryMib !== undefined && { memoryMib: input.memoryMib }),
        ...(input.diskMib !== undefined && { diskMib: input.diskMib }),
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
      });

      emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpAdded', reason: 'created', imp });

      return imp;
    }),
    list: os.imps.list.handler((options) =>
      impCollection
        .findMany()
        .filter((imp) => isImpAllowed(options.context.session.imps, imp.name)),
    ),
    get: os.imps.get.handler((options) => findImp(options.input.name)),
    destroy: os.imps.destroy.handler((options) => {
      const imp = findImp(options.input.name);

      impCollection.delete((query) => query.where({ name: imp.name }));
      checkpointCollection.deleteMany((query) => query.where({ imp: imp.name }));

      emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpRemoved', imp });

      return {};
    }),
    start: os.imps.start.handler((options) =>
      updateImp(options.input.name, 'booted', { state: 'running' }),
    ),
    stop: os.imps.stop.handler((options) =>
      updateImp(options.input.name, 'stopped', { state: 'stopped' }),
    ),
    sleep: os.imps.sleep.handler((options) =>
      updateImp(options.input.name, 'slept', { state: 'sleeping' }),
    ),
    wake: os.imps.wake.handler((options) =>
      updateImp(options.input.name, 'woke', { state: 'running' }),
    ),
    url: os.imps.url.handler((options) => ({
      local: findImp(options.input.name).url,
      https: null,
      public: null,
      service: null,
      tailnet: null,
    })),
    update: os.imps.update.handler((options) => {
      const input = options.input;
      const imp = findImp(input.name);

      return updateImp(input.name, 'updated', {
        cpu: {
          limit: input.cpuLimit === undefined ? (imp.cpu?.limit ?? null) : input.cpuLimit,
          weight: input.cpuWeight ?? imp.cpu?.weight ?? 100,
        },
        ...(input.vcpus !== undefined && { vcpus: input.vcpus }),
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
      });
    }),

    // disk only: the new imp takes the source's image and disk, from the
    // checkpoint when one is named
    fork: os.imps.fork.handler(async (options) => {
      const input = options.input;
      const source = findImp(input.source);

      const checkpoint =
        input.checkpoint === undefined ? null : findCheckpoint(source.name, input.checkpoint);

      if (impCollection.findFirst((query) => query.where({ name: input.name })) !== undefined) {
        throw buildConflictError('imp', input.name);
      }

      const imp = await impCollection.create({
        name: input.name,
        image: source.image,
        diskMib: checkpoint?.diskMib ?? source.diskMib,
        state: 'stopped',
      });

      emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpAdded', reason: 'created', imp });

      return imp;
    }),
  },
  checkpoints: {
    create: os.checkpoints.create.handler(async (options) => {
      const imp = findImp(options.input.name);

      const row = await checkpointCollection.create({
        imp: imp.name,
        diskMib: imp.diskMib,
        ...(options.input.label !== undefined && { label: options.input.label }),
      });

      const checkpoint = toCheckpoint(row);

      emitImpdEvent({
        v: EVENT_VERSION,
        at: new Date(),
        ev: 'CheckpointAdded',
        name: imp.name,
        checkpoint,
      });

      return checkpoint;
    }),
    list: os.checkpoints.list.handler((options) => {
      const imp = findImp(options.input.name);

      return checkpointCollection
        .findMany((query) => query.where({ imp: imp.name }))
        .map((row) => toCheckpoint(row));
    }),

    // the imp boots from the checkpoint's disk
    restore: os.checkpoints.restore.handler((options) => {
      findCheckpoint(findImp(options.input.name).name, options.input.checkpoint);

      return updateImp(options.input.name, 'restored', { state: 'running' });
    }),
    delete: os.checkpoints.delete.handler((options) => {
      const imp = findImp(options.input.name);
      const checkpoint = findCheckpoint(imp.name, options.input.checkpoint);

      checkpointCollection.delete((query) => query.where({ imp: imp.name, id: checkpoint.id }));

      emitImpdEvent({
        v: EVENT_VERSION,
        at: new Date(),
        ev: 'CheckpointRemoved',
        name: imp.name,
        checkpoint,
      });

      return {};
    }),
  },
  images: {
    list: os.images.list.handler(() => imageCollection.findMany()),
    add: os.images.add.handler((options) => {
      const input = options.input;

      return 'imp' in input
        ? imageCollection.create({ name: input.name, ref: `imp:${input.imp}`, source: 'imp' })
        : imageCollection.create({
            name: input.name ?? deriveImageName(input.ref),
            ref: input.ref,
          });
    }),
    delete: os.images.delete.handler((options) => {
      const image = imageCollection.findFirst((query) => query.where({ name: options.input.name }));

      if (image === undefined) {
        throw buildNotFoundError('image', options.input.name);
      }

      imageCollection.delete((query) => query.where({ name: image.name }));

      return {};
    }),
  },
  events: {
    stream: os.events.stream.handler((options) =>
      openImpdEventStream(
        impCollection
          .findMany()
          .filter((imp) => isImpAllowed(options.context.session.imps, imp.name)),
        options.signal,
      ),
    ),
  },
  system: {
    info: os.system.info.handler(
      () => systemInfoCollection.findFirst() ?? SystemInfoRowSchema.parse({}),
    ),
  },
  tokens: {
    list: os.tokens.list.handler(() => tokenCollection.findMany().map((row) => toToken(row))),
    create: os.tokens.create.handler(async (options) => {
      const input = options.input;

      if (tokenCollection.findFirst((query) => query.where({ name: input.name })) !== undefined) {
        throw buildConflictError('token', input.name);
      }

      const row = await tokenCollection.create({
        name: input.name,
        scope: input.scope,
        imps: input.imps ?? null,
        ...(input.grantable !== undefined && { grantable: input.grantable }),
      });

      return { token: toToken(row), secret: row.secret };
    }),
    update: os.tokens.update.handler(async (options) => {
      const updated = await tokenCollection.update(
        (query) => query.where({ name: options.input.name }),
        {
          data(row) {
            row.grantable = options.input.grantable;
          },
        },
      );

      if (updated === undefined) {
        throw buildNotFoundError('token', options.input.name);
      }

      return toToken(updated);
    }),
    delete: os.tokens.delete.handler((options) => {
      const token = tokenCollection.findFirst((query) => query.where({ name: options.input.name }));

      if (token === undefined) {
        throw buildNotFoundError('token', options.input.name);
      }

      tokenCollection.delete((query) => query.where({ name: token.name }));

      return {};
    }),
    whoami: os.tokens.whoami.handler((options) => options.context.session),
  },
};

function findImp(name: string): Imp {
  const imp = impCollection.findFirst((query) => query.where({ name }));

  if (imp === undefined) {
    throw buildNotFoundError('imp', name);
  }

  return imp;
}

// as impd: the checkpoint's id or its label
function findCheckpoint(imp: string, ref: string): Checkpoint {
  const row =
    checkpointCollection.findFirst((query) => query.where({ imp, id: ref })) ??
    checkpointCollection.findFirst((query) => query.where({ imp, label: ref }));

  if (row === undefined) {
    throw buildNotFoundError('checkpoint', ref);
  }

  return toCheckpoint(row);
}

// the imp's record changes, and every open stream hears why
async function updateImp(name: string, reason: ImpChangeReason, change: Partial<Imp>) {
  findImp(name);

  const imp = await impCollection.update((query) => query.where({ name }), {
    data(record) {
      Object.assign(record, change);
    },
  });

  if (imp === undefined) {
    throw buildNotFoundError('imp', name);
  }

  emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpChanged', reason, imp });

  return imp;
}

function toCheckpoint(row: Readonly<Checkpoint & { readonly imp: string }>): Checkpoint {
  const { imp: _imp, ...checkpoint } = row;

  return checkpoint;
}

function toToken(row: Readonly<Token & { readonly secret: string }>): Token {
  const { secret: _secret, ...token } = row;

  return token;
}

// the caller impd builds for a dashboard session (packages/daemon
// auth/caller.ts), named after its token
function toCaller(session: Readonly<Identity>): Caller {
  return {
    kind: session.kind,
    name: session.name,
    scope: session.scope,
    imps: session.imps,
    grantable: session.grantable.map((name) => ({ name, generation: '1' })),
    tokenId: session.name,
    grantId: null,
    expiresAt: null,
    principal: session.name,
    display: session.name,
  };
}
