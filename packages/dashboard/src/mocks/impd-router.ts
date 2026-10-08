import type { Checkpoint, Identity, Image, Imp, ImpChangeReason, ImpState, Token } from '@imp/api';
import { EVENT_VERSION, impContract, isImpAllowed } from '@imp/api';
import {
  buildConflictError,
  buildForbiddenError,
  buildInvalidStateError,
  buildNotFoundError,
} from '@imp/daemon/src/api-errors';
import { checkAccess, findAccess } from '@imp/daemon/src/auth/access-policy';
import type { Caller } from '@imp/daemon/src/auth/caller';
import { toLeaseSummary } from '@imp/daemon/src/auth/caller-view';
import { deriveImageName } from '@imp/daemon/src/images/image-naming';
import { requireTransition } from '@imp/daemon/src/imps/imp-transitions';
import { implement } from '@orpc/server';
import { checkpointCollection } from './db/checkpoint-collection';
import { imageCollection } from './db/image-collection';
import { impCollection } from './db/imp-collection';
import { systemInfoCollection } from './db/system-info-collection';
import { tokenCollection } from './db/token-collection';
import { emitImpdEvent, openImpdEventStream } from './impd-events';

// the browser's dashboard session: who it is, and when it ends
export interface ImpdSession extends Identity {
  readonly expiresAt: Date;
}

// what each call runs as
interface ImpdRouterContext {
  readonly session: ImpdSession;
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
// procedure left out answers impd's 404; imps go out with the caller's view
// of their leases, which the mock holds none of.
export const impdRouter = {
  imps: {
    create: os.imps.create.handler(async (options) => {
      const input = options.input;

      if (input.name !== undefined) {
        requireFreeImpName(input.name);
      }

      const imp = await impCollection.create({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.image !== undefined && { image: input.image }),
        ...(input.vcpus !== undefined && { vcpus: input.vcpus }),
        ...(input.memoryMib !== undefined && { memoryMib: input.memoryMib }),
        ...(input.diskMib !== undefined && { diskMib: input.diskMib }),
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
      });

      emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpAdded', reason: 'created', imp });

      return toCallerImp(options.context.session, imp);
    }),

    // image builders only when asked for
    list: os.imps.list.handler((options) =>
      impCollection
        .findMany()
        .filter((imp) => isImpAllowed(options.context.session.imps, imp.name))
        .filter((imp) => options.input?.builders === true || imp.kind !== 'builder')
        .map((imp) => toCallerImp(options.context.session, imp)),
    ),
    get: os.imps.get.handler((options) =>
      toCallerImp(options.context.session, findImp(options.input.name)),
    ),
    destroy: os.imps.destroy.handler((options) => {
      const imp = findImp(options.input.name);

      impCollection.delete((query) => query.where({ name: imp.name }));
      checkpointCollection.deleteMany((query) => query.where({ imp: imp.name }));

      emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpRemoved', imp });

      return {};
    }),
    start: os.imps.start.handler(async (options) => {
      const started = await requireRunningImp(options.input.name);

      return toCallerImp(options.context.session, started);
    }),
    stop: os.imps.stop.handler(async (options) => {
      const stopped = await writeImpState(options.input.name, 'stopped', 'stop', 'stopped');

      return toCallerImp(options.context.session, stopped);
    }),
    sleep: os.imps.sleep.handler(async (options) => {
      const slept = await writeImpState(options.input.name, 'sleeping', 'sleep', 'slept');

      return toCallerImp(options.context.session, slept);
    }),

    // restartError: false refuses an imp in error, as impd does
    wake: os.imps.wake.handler(async (options) => {
      const imp = findImp(options.input.name);

      if (imp.state === 'error' && options.input.restartError === false) {
        throw buildInvalidStateError(imp.state, ['running', 'sleeping', 'stopped'], 'wake');
      }

      const woken = await requireRunningImp(imp.name);

      return toCallerImp(options.context.session, woken);
    }),
    url: os.imps.url.handler((options) => ({
      local: findImp(options.input.name).url,
      https: null,
      public: null,
      service: null,
      tailnet: null,
    })),
    update: os.imps.update.handler(async (options) => {
      const input = options.input;
      const imp = findImp(input.name);

      const updated = await updateImp(input.name, 'updated', {
        cpu: {
          limit: input.cpuLimit === undefined ? (imp.cpu?.limit ?? null) : input.cpuLimit,
          weight: input.cpuWeight ?? imp.cpu?.weight ?? 100,
        },
        ...(input.vcpus !== undefined && { vcpus: input.vcpus }),
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
      });

      return toCallerImp(options.context.session, updated);
    }),

    // disk only: the new imp takes the source's image and disk, from the
    // checkpoint when one is named, stopped; no grants to copy
    fork: os.imps.fork.handler(async (options) => {
      const input = options.input;
      const source = findImp(input.source);

      const checkpoint =
        input.checkpoint === undefined ? null : findCheckpoint(source.name, input.checkpoint);

      requireFreeImpName(input.name);

      const imp = await impCollection.create({
        name: input.name,
        image: source.image,
        diskMib: checkpoint?.diskMib ?? source.diskMib,
        state: 'stopped',
      });

      emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpAdded', reason: 'created', imp });

      return { ...toCallerImp(options.context.session, imp), grantsNotCopied: [] };
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
    restore: os.checkpoints.restore.handler(async (options) => {
      findCheckpoint(findImp(options.input.name).name, options.input.checkpoint);

      const restored = await updateImp(options.input.name, 'restored', { state: 'running' });

      return toCallerImp(options.context.session, restored);
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
        ? writeTemplate(input.name, findImp(input.imp))
        : writeDockerImage(input.name ?? deriveImageName(input.ref), input.ref);
    }),

    // as impd: an image an imp still uses stays
    delete: os.images.delete.handler((options) => {
      const name = options.input.name;
      const image = imageCollection.findFirst((query) => query.where({ name }));

      if (image === undefined) {
        throw buildNotFoundError('image', name);
      }

      const users = impCollection.findMany((query) => query.where({ image: name })).length;

      if (users > 0) {
        throw buildConflictError('image', name, `image ${name} is used by ${String(users)} imp(s)`);
      }

      imageCollection.delete((query) => query.where({ name }));

      return {};
    }),
  },
  events: {
    stream: os.events.stream.handler((options) =>
      openImpdEventStream(options.context.session, () => impCollection.findMany(), options.signal),
    ),
  },
  system: {
    // a host of default values, kept from the first read when none is seeded
    info: os.system.info.handler(
      () => systemInfoCollection.findFirst() ?? systemInfoCollection.create({}),
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
    whoami: os.tokens.whoami.handler((options) => toIdentity(options.context.session)),
  },
};

function findImp(name: string): Imp {
  const imp = impCollection.findFirst((query) => query.where({ name }));

  if (imp === undefined) {
    throw buildNotFoundError('imp', name);
  }

  return imp;
}

// impd's CONFLICT for a name another imp has (packages/daemon
// imps/create-imp-record.ts)
function requireFreeImpName(name: string): void {
  if (impCollection.findFirst((query) => query.where({ name })) !== undefined) {
    throw buildConflictError('imp', name);
  }
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

// A stop or a sleep: an imp already there answers as it is, any other goes
// through impd's lifecycle (packages/daemon imps/imp-transitions.ts), which
// answers INVALID_STATE for a move it does not allow
function writeImpState(name: string, to: ImpState, action: string, reason: ImpChangeReason) {
  const imp = findImp(name);

  if (imp.state === to) {
    return Promise.resolve(imp);
  }

  requireTransition(imp.state, to, action);

  return updateImp(name, reason, { state: to });
}

// A start or a wake (impd's requireRunningImp): a running imp as it is, a
// sleeping one woken, any other booted where its state allows
function requireRunningImp(name: string) {
  const imp = findImp(name);

  if (imp.state === 'running') {
    return Promise.resolve(imp);
  }

  if (imp.state === 'sleeping') {
    return updateImp(name, 'woke', { state: 'running' });
  }

  requireTransition(imp.state, 'running', 'start');

  return updateImp(name, 'booted', { state: 'running' });
}

// impd's templates (packages/daemon images/template-service.ts): the name
// of a docker image is refused, a template's is made again
function writeTemplate(name: string, imp: Imp): Promise<Image> {
  const existing = imageCollection.findFirst((query) => query.where({ name }));

  if (existing?.source === 'oci') {
    throw buildConflictError(
      'image',
      name,
      `image ${name} is a docker image; give the template a name of its own`,
    );
  }

  return writeImageRow(name, { ref: `imp:${imp.name}`, source: 'imp' });
}

// impd's pull (packages/daemon images/image-service.ts): the name of a
// template is refused, a docker image's is pulled again
function writeDockerImage(name: string, ref: string): Promise<Image> {
  const existing = imageCollection.findFirst((query) => query.where({ name }));

  if (existing?.source === 'imp') {
    throw buildConflictError(
      'image',
      name,
      `image ${name} is a template; make it again from an imp, or pick another name`,
    );
  }

  return writeImageRow(name, { ref });
}

// the image row by its name: made, or moved to what was made again
async function writeImageRow(
  name: string,
  made: Pick<Image, 'ref'> & Partial<Pick<Image, 'source'>>,
): Promise<Image> {
  const updated = await imageCollection.update((query) => query.where({ name }), {
    data(row) {
      Object.assign(row, made);
    },
  });

  return updated ?? imageCollection.create({ name, ...made });
}

function toCallerImp(session: Readonly<ImpdSession>, imp: Imp): Imp {
  return { ...imp, leases: toLeaseSummary(toCaller(session), imp.name, []) };
}

function toCheckpoint(row: Readonly<Checkpoint & { readonly imp: string }>): Checkpoint {
  const { imp: _imp, ...checkpoint } = row;

  return checkpoint;
}

function toToken(row: Readonly<Token & { readonly secret: string }>): Token {
  const { secret: _secret, ...token } = row;

  return token;
}

function toIdentity(session: Readonly<ImpdSession>): Identity {
  const { expiresAt: _expiresAt, ...identity } = session;

  return identity;
}

// the caller impd builds for a dashboard session (packages/daemon
// auth/authenticate.ts), named after its token
function toCaller(session: Readonly<ImpdSession>): Caller {
  return {
    kind: session.kind,
    name: session.name,
    scope: session.scope,
    imps: session.imps,
    grantable: session.grantable.map((name) => ({ name, generation: '1' })),
    tokenId: session.name,
    grantId: null,
    expiresAt: session.expiresAt.getTime(),
    principal: session.name,
    display: session.name,
  };
}
