import type {
  Checkpoint,
  Identity,
  Image,
  Imp,
  ImpChangeReason,
  ImpState,
  SshKey,
  SystemInfo,
  Token,
} from '@imp/api';
import { EVENT_VERSION, impContract, isImpAllowed } from '@imp/api';
import {
  buildBuilderError,
  buildConflictError,
  buildForbiddenError,
  buildInvalidStateError,
  buildNotFoundError,
} from '@imp/daemon/src/api-errors';
import { checkAccess, findAccess } from '@imp/daemon/src/auth/access-policy';
import { readChangedImps } from '@imp/daemon/src/auth/builder-calls';
import type { Caller } from '@imp/daemon/src/auth/caller';
import { toLeaseSummary } from '@imp/daemon/src/auth/caller-view';
import { deriveImageName } from '@imp/daemon/src/images/image-naming';
import { resolveCpuSettings } from '@imp/daemon/src/imps/cpu-limit';
import { requireTransition } from '@imp/daemon/src/imps/imp-transitions';
import { formatKeyFingerprint, parsePublicKey } from '@imp/daemon/src/ssh/authorized-keys';
import { ORPCError, implement } from '@orpc/server';
import { checkpointCollection } from './db/checkpoint-collection';
import { hostCollection } from './db/host-collection';
import { imageCollection } from './db/image-collection';
import { impCollection } from './db/imp-collection';
import { impPolicyCollection } from './db/imp-policy-collection';
import { secretCollection } from './db/secret-collection';
import { tokenCollection } from './db/token-collection';
import { emitImpdEvent, openImpdEventStream } from './impd-events';

// the browser's dashboard session: who its token makes it, and when it ends
export interface ImpdSession extends Identity {
  readonly expiresAt: Date;
}

// what each call runs as
interface ImpdRouterContext {
  readonly session: ImpdSession;
}

const MIB = 1024 * 1024;

// impd's root token, which no made token may be named after
const ROOT_NAME = 'root';

// what impd says it can do (SYSTEM_FEATURES in packages/daemon
// build-router.ts, which it does not export)
const SYSTEM_FEATURES = {
  sessionOffsets: true,
  leases: true,
  grantableTokens: true,
  tokenUpdate: true,
  secretRebind: true,
  databaseCopy: true,
  imageBuildStream: true,
  imageOpStream: true,
  execRequire: true,
  oauthGrants: true,
  secretFilesGc: true,
  sessionLog: true,
  publicEgress: true,
  oauthSecrets: true,
  secretUpstream: true,
} as const;

// Every call passes impd's own access check (packages/daemon
// auth/access-policy.ts), then its refusal of a change to an image builder.
const os = implement(impContract)
  .$context<ImpdRouterContext>()
  .use(async (options, input) => {
    const procedure = options.path.join('.');
    const access = findAccess(procedure);

    const refusal = await checkAccess(
      access,
      toCaller(options.context.session),
      input,

      // the dashboard grants no secrets
      () => Promise.resolve(null),
    );

    if (refusal !== null) {
      throw buildForbiddenError(refusal.message, refusal.reason);
    }

    for (const name of readChangedImps(procedure, access, input)) {
      if (impCollection.findFirst((query) => query.where({ name }))?.kind === 'builder') {
        throw buildBuilderError(name);
      }
    }

    return options.next();
  });

// The procedures the dashboard calls, over the collections in ./db. A
// procedure left out answers impd's 404; imps go out with the caller's view
// of their leases, which the mock holds none of.
export const impdRouter = {
  imps: {
    // made `creating`, then booted, as impd streams it
    create: os.imps.create.handler(async (options) => {
      const input = options.input;

      const host = await readHost();

      const image =
        input.image === undefined ? requireDefaultImage(host.defaultImage) : findImage(input.image);

      if (input.name !== undefined) {
        requireFreeImpName(input.name);
      }

      const cpu = resolveCpuSettings(input, null, host.cpu.hostCpus);

      const imp = await impCollection.create({
        ...(input.name !== undefined && { name: input.name }),
        image: image.name,
        state: 'creating',
        vcpus: input.vcpus ?? host.defaultVcpus,
        memoryMib: input.memoryMib ?? host.defaultMemoryMib,
        ...(input.maxMemoryMib !== undefined && { maxMemoryMib: input.maxMemoryMib }),
        ...(input.diskMib !== undefined && { diskMib: input.diskMib }),
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
        cpu,
      });

      await impPolicyCollection.create({
        imp: imp.name,
        ...(input.policy !== undefined && { policy: input.policy }),
      });

      const booted = await emitImpCreation(imp);

      return toCallerImp(options.context.session, booted);
    }),

    // by name, image builders only when asked for
    list: os.imps.list.handler((options) =>
      listImps()
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
      impPolicyCollection.deleteMany((query) => query.where({ imp: imp.name }));
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

    // impd's updateImp (packages/daemon imps/imp-commands.ts)
    update: os.imps.update.handler(async (options) => {
      const input = options.input;
      const imp = findImp(input.name);
      const vcpus = input.vcpus ?? imp.vcpus;

      if (vcpus !== imp.vcpus && imp.state !== 'stopped') {
        throw buildInvalidStateError(imp.state, ['stopped'], 'change the vCPU count of');
      }

      const host = await readHost();

      const cpu = resolveCpuSettings(input, imp.cpu ?? null, host.cpu.hostCpus);

      const updated = await updateImp(input.name, 'updated', {
        cpu,
        vcpus,
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
      });

      return toCallerImp(options.context.session, updated);
    }),

    // disk only: the new imp takes the source's image, size and CPU
    // settings, and its disk from the checkpoint when one is named; it boots
    fork: os.imps.fork.handler(async (options) => {
      const input = options.input;
      const source = findImp(input.source);

      const checkpoint =
        input.checkpoint === undefined ? null : findCheckpoint(source.name, input.checkpoint);

      if (checkpoint === null && source.state === 'creating') {
        throw buildInvalidStateError(
          source.state,
          ['running', 'sleeping', 'stopped', 'error'],
          'fork',
        );
      }

      requireFreeImpName(input.name);

      const imp = await impCollection.create({
        name: input.name,
        image: source.image,
        state: 'creating',
        vcpus: source.vcpus,
        memoryMib: source.memoryMib,
        ...(source.maxMemoryMib !== undefined && { maxMemoryMib: source.maxMemoryMib }),
        diskMib: checkpoint?.diskMib ?? source.diskMib,
        ...(source.cpu !== undefined && { cpu: source.cpu }),
      });

      const policy = impPolicyCollection.findFirst((query) => query.where({ imp: source.name }));

      await impPolicyCollection.create({
        imp: imp.name,
        ...(policy !== undefined && { policy: policy.policy }),
      });

      const booted = await emitImpCreation(imp);

      return { ...toCallerImp(options.context.session, booted), grantsNotCopied: [] };
    }),
  },
  checkpoints: {
    // impd's createCheckpoint (packages/daemon checkpoints/checkpoint-service.ts)
    create: os.checkpoints.create.handler(async (options) => {
      const imp = findImp(options.input.name);
      const label = options.input.label;

      if (label !== undefined) {
        // a label must not look like an id (isValidCheckpointLabel)
        if (label.startsWith('cp-')) {
          throw new ORPCError('BAD_REQUEST', { message: 'a label must not start with cp-' });
        }

        if (readCheckpoint(imp.name, label) !== undefined) {
          throw buildConflictError('checkpoint', label);
        }
      }

      const row = await checkpointCollection.create({
        imp: imp.name,
        createdAt: new Date(),
        diskMib: imp.diskMib,
        ...(label !== undefined && { label }),
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

    // newest first
    list: os.checkpoints.list.handler((options) => {
      const imp = findImp(options.input.name);

      return checkpointCollection
        .findMany((query) => query.where({ imp: imp.name }))
        .toSorted(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || readTextOrder(b.id, a.id),
        )
        .map((row) => toCheckpoint(row));
    }),

    // impd's restoreCheckpoint: the disk is the checkpoint's, at its size;
    // an awake imp boots on it, any other stays as it was
    restore: os.checkpoints.restore.handler(async (options) => {
      const imp = findImp(options.input.name);
      const checkpoint = findCheckpoint(imp.name, options.input.checkpoint);

      if (imp.state === 'creating') {
        throw buildInvalidStateError(
          imp.state,
          ['running', 'sleeping', 'stopped', 'error'],
          'restore',
        );
      }

      const isAwake = imp.state === 'running' || imp.state === 'sleeping';

      const restored = await updateImp(imp.name, 'restored', {
        diskMib: checkpoint.diskMib,
        ...(isAwake && { state: 'running' }),
      });

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
      const image = findImage(options.input.name);
      const users = impCollection.findMany((query) => query.where({ image: image.name })).length;

      if (users > 0) {
        throw buildConflictError(
          'image',
          image.name,
          `image ${image.name} is used by ${String(users)} imp(s)`,
        );
      }

      imageCollection.delete((query) => query.where({ name: image.name }));

      return {};
    }),
  },
  events: {
    stream: os.events.stream.handler((options) =>
      openImpdEventStream(options.context.session, () => listImps(), options.signal),
    ),
  },
  system: {
    info: os.system.info.handler(() => readSystemInfo()),
  },
  tokens: {
    // by name
    list: os.tokens.list.handler(() =>
      tokenCollection
        .findMany()
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((row) => toToken(row)),
    ),

    // impd's token store (packages/daemon auth/token-store.ts)
    create: os.tokens.create.handler(async (options) => {
      const input = options.input;

      if (input.name === ROOT_NAME || readToken(input.name) !== undefined) {
        throw buildConflictError('token', input.name);
      }

      const imps = input.imps ?? null;
      const sshKeys = requireDistinctKeys((input.sshKeys ?? []).map((line) => readSshKey(line)));
      const grantable = readGrantable(input.grantable ?? [], { scope: input.scope, imps });

      const row = await tokenCollection.create({
        name: input.name,
        scope: input.scope,
        imps,
        ...(sshKeys.length > 0 && { sshKeys }),
        ...(grantable.length > 0 && { grantable }),
        createdAt: new Date(),
      });

      return { token: toToken(row), secret: row.secret };
    }),
    update: os.tokens.update.handler(async (options) => {
      const token = readToken(options.input.name);

      if (token === undefined) {
        throw buildNotFoundError('token', options.input.name);
      }

      const grantable = readGrantable(options.input.grantable, token);

      const updated = await tokenCollection.update((query) => query.where({ name: token.name }), {
        data(row) {
          row.grantable = grantable;
        },
      });

      if (updated === undefined) {
        throw buildNotFoundError('token', token.name);
      }

      return toToken(updated);
    }),
    delete: os.tokens.delete.handler((options) => {
      const token = readToken(options.input.name);

      if (token === undefined) {
        throw buildNotFoundError('token', options.input.name);
      }

      tokenCollection.delete((query) => query.where({ name: token.name }));

      return {};
    }),
    whoami: os.tokens.whoami.handler((options) => toIdentity(options.context.session)),
  },
};

// the host's row, kept from the first read when none is seeded
async function readHost() {
  const host = hostCollection.findFirst();

  if (host !== undefined) {
    return host;
  }

  const created = await hostCollection.create({});

  return created;
}

// impd's readSystemInfo (packages/daemon build-router.ts): the host's
// numbers, and what the imp rows add up to
async function readSystemInfo(): Promise<SystemInfo> {
  const host = await readHost();

  const imps = listImps();
  const running = imps.filter((imp) => imp.state === 'running');
  const sleeping = imps.filter((imp) => imp.state === 'sleeping');
  const defaultImage = findDefaultImage(host.defaultImage);

  return {
    version: host.version,
    ramBudgetMib: host.ramBudgetMib,
    ramUsedMib: running.reduce((sum, imp) => sum + (imp.ramMib ?? 0), 0),
    ramReservedMib: host.ramReservedMib,
    ramCommittedMib: running.reduce((sum, imp) => sum + (imp.maxMemoryMib ?? imp.memoryMib), 0),
    ramSleepingMib: sleeping.reduce((sum, imp) => sum + imp.memoryMib, 0),
    awakeCount: running.length,
    impCount: imps.length,
    sessionCount: imps.reduce((sum, imp) => sum + (imp.sessions ?? 0), 0),
    bootStatus: countBootStatuses(imps),
    firecrackerVersion: host.firecrackerVersion,
    guestKernel: host.guestKernel,
    systemDrive: host.systemDrive,
    storage: {
      backend: host.backend,
      ...host.disk,
      impDiskBytes: imps.reduce((sum, imp) => sum + imp.diskMib * MIB, 0),
    },
    tailscale: host.tailscale,
    cpu: host.cpu,
    defaults: { memoryMib: host.defaultMemoryMib, image: defaultImage?.name ?? null },
    egress: { isEnforced: host.isEgressEnforced },
    ksm: host.ksm === null ? null : { ...host.ksm, unmergeable: 0 },
    public:
      host.publicIp === null
        ? null
        : {
            ip: host.publicIp,
            imps: imps.filter((imp) => imp.public !== undefined).length,
            records: host.publicRecords,
          },
    https: host.https,
    features: SYSTEM_FEATURES,
  };
}

// impd's countBootStatuses (packages/daemon imps/boot-status.ts, whose
// imports reach past the browser), over what each awake imp's record says
function countBootStatuses(imps: readonly Imp[]): SystemInfo['bootStatus'] {
  const outdated = { firecracker: 0, kernel: 0, agent: 0 };
  const awake = imps.filter((imp) => imp.state === 'running' || imp.state === 'sleeping');
  let noIpv6 = 0;

  for (const imp of awake) {
    for (const part of imp.outdated ?? []) {
      if (part === 'ipv6') {
        noIpv6 += 1;
      } else if (part !== 'impd') {
        outdated[part] += 1;
      }
    }
  }

  const coldBoots = awake.filter((imp) => {
    const parts = imp.outdated ?? [];

    return imp.state === 'sleeping'
      ? imp.coldBootReason !== undefined
      : parts.includes('firecracker') || parts.includes('impd');
  }).length;

  return { coldBoots, outdated: noIpv6 === 0 ? outdated : { ...outdated, ipv6: noIpv6 } };
}

// by name, as impd's listImps
function listImps(): Imp[] {
  return impCollection.findMany().toSorted((a, b) => readTextOrder(a.name, b.name));
}

function findImp(name: string): Imp {
  const imp = impCollection.findFirst((query) => query.where({ name }));

  if (imp === undefined) {
    throw buildNotFoundError('imp', name);
  }

  return imp;
}

function findImage(name: string): Image {
  const image = imageCollection.findFirst((query) => query.where({ name }));

  if (image === undefined) {
    throw buildNotFoundError('image', name);
  }

  return image;
}

// impd's FALLBACK_DEFAULT_IMAGE (packages/daemon images/image-service.ts),
// which the daemon does not export
const FALLBACK_DEFAULT_IMAGE = 'ubuntu';

// impd's findDefaultImage (packages/daemon images/image-service.ts): the
// configured default, or `ubuntu` when that is gone
function findDefaultImage(configured: string): Image | undefined {
  return [configured, FALLBACK_DEFAULT_IMAGE]
    .map((name) => imageCollection.findFirst((query) => query.where({ name })))
    .find((image) => image !== undefined);
}

function requireDefaultImage(configured: string): Image {
  const image = findDefaultImage(configured);

  if (image === undefined) {
    throw buildNotFoundError('image', configured);
  }

  return image;
}

function readToken(name: string) {
  return tokenCollection.findFirst((query) => query.where({ name }));
}

// impd's CONFLICT for a name another imp has (packages/daemon
// imps/create-imp-record.ts)
function requireFreeImpName(name: string): void {
  if (impCollection.findFirst((query) => query.where({ name })) !== undefined) {
    throw buildConflictError('imp', name);
  }
}

// as impd: the checkpoint by its id or its label
function readCheckpoint(imp: string, ref: string) {
  return (
    checkpointCollection.findFirst((query) => query.where({ imp, id: ref })) ??
    checkpointCollection.findFirst((query) => query.where({ imp, label: ref }))
  );
}

function findCheckpoint(imp: string, ref: string): Checkpoint {
  const row = readCheckpoint(imp, ref);

  if (row === undefined) {
    throw buildNotFoundError('checkpoint', ref);
  }

  return toCheckpoint(row);
}

// a new imp in the stream, then its boot
function emitImpCreation(imp: Imp): Promise<Imp> {
  emitImpdEvent({ v: EVENT_VERSION, at: new Date(), ev: 'ImpAdded', reason: 'created', imp });

  return updateImp(imp.name, 'booted', { state: 'running' });
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

// impd's readGrantable: only a manage token for some imps takes a list, of
// secrets that exist
function readGrantable(
  names: readonly string[],
  token: Readonly<Pick<Token, 'scope' | 'imps'>>,
): string[] {
  if (names.length === 0) {
    return [];
  }

  if (token.imps === null || token.scope !== 'manage') {
    throw new ORPCError('BAD_REQUEST', {
      message: 'a token that may grant secrets needs scope manage and imp patterns',
    });
  }

  return names.map((name) => {
    if (secretCollection.findFirst((query) => query.where({ name })) === undefined) {
      throw buildNotFoundError('secret', name);
    }

    return name;
  });
}

// impd's key entry: a parsed key that no token holds yet
// impd's buildKeyEntries (packages/daemon auth/token-store.ts): one key
// given twice in a list is a CONFLICT
function requireDistinctKeys(keys: readonly SshKey[]): SshKey[] {
  const seen = new Set<string>();

  for (const key of keys) {
    if (seen.has(key.fingerprint)) {
      throw buildConflictError('ssh-key', key.fingerprint, 'the same key is given twice');
    }

    seen.add(key.fingerprint);
  }

  return [...keys];
}

function readSshKey(line: string): SshKey {
  const key = parsePublicKey(line);

  if (typeof key === 'string') {
    throw new ORPCError('BAD_REQUEST', { message: `not an SSH public key: ${key}` });
  }

  const fingerprint = formatKeyFingerprint(key.blob);

  const isBound = tokenCollection
    .findMany()
    .some((token) => token.sshKeys.some((bound) => bound.fingerprint === fingerprint));

  if (isBound) {
    throw buildConflictError('ssh-key', fingerprint, `key ${fingerprint} is bound to a token`);
  }

  return { fingerprint, type: key.type, comment: key.comment };
}

function readTextOrder(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
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
