import { rmSync } from 'node:fs';
import type { Checkpoint, Imp } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildConflictError, buildInvalidStateError, buildNotFoundError } from '../api-errors';
import type { Config } from '../config';
import {
  createCheckpoint,
  findCheckpoint,
  listCheckpoints,
  removeCheckpoint,
  toApiCheckpoint,
} from '../db/checkpoints';
import type { CheckpointRecord } from '../db/checkpoints';
import { writeNextBootCause } from '../db/cold-boots';
import { readEgressPolicy } from '../db/egress';
import { findImpByName, updateImpDisk, updateImpState } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { toLockedImp } from '../imps/imp-lock';
import type { ImpCheckpointHooks } from '../imps/imp-service';
import { printLog } from '../process/print-log';
import { readErrorMessage } from '../read-error-message';
import type { DiskBudget } from '../storage/disk-budget';
import { CheckpointIdTakenError } from '../storage/storage-backend';
import type { StorageBackend } from '../storage/storage-backend';
import { createConsistentDisk } from './consistent-disk';
import type { DiskFreezer } from './consistent-disk';

// Short, typeable and global, so the existing primary key holds them without
// a migration, and an id never comes back after a delete (unlike v1, v2…).
const CHECKPOINT_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CHECKPOINT_ID_PREFIX = 'cp-';
const ID_ATTEMPTS = 3;

interface ForkInput {
  readonly source: string;
  readonly name: string;
  readonly checkpoint?: string | undefined;
}

export interface CheckpointService {
  readonly createCheckpoint: (name: string, label: string | undefined) => Promise<Checkpoint>;
  readonly listCheckpoints: (name: string) => Promise<Checkpoint[]>;
  readonly deleteCheckpoint: (name: string, ref: string) => Promise<void>;

  // stops the VM, puts the checkpoint's disk in place, drops any memory
  // snapshot, and boots again if the imp was awake
  readonly restoreCheckpoint: (name: string, ref: string) => Promise<Imp>;

  // disk only: a memory fork would duplicate entropy and IDs
  // (docs/architecture/storage.md#checkpoints-restores-and-forks)
  readonly forkImp: (input: ForkInput) => Promise<ForkedImp>;
}

// the fork, and the id of the source it was checked against: its name may
// belong to another imp by the time the grants are copied
interface ForkedImp {
  readonly imp: Imp;
  readonly sourceId: string;
}

export interface CheckpointServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: ImpCheckpointHooks;
  readonly storage: StorageBackend;
  readonly log?: (message: string) => void;
  readonly freezer?: DiskFreezer;

  // a checkpoint is thin, but none is made past the reserve
  readonly diskBudget: Pick<DiskBudget, 'requireRoom'>;

  // the draws each new checkpoint id is made from; Math.random by default
  readonly random?: () => number;
}

export function buildCheckpointId(random: () => number = Math.random): string {
  const picks = Array.from({ length: 6 }, () =>
    Math.floor(random() * CHECKPOINT_ID_ALPHABET.length),
  );

  return CHECKPOINT_ID_PREFIX + picks.map((pick) => CHECKPOINT_ID_ALPHABET[pick]).join('');
}

// A label is looked up the same way as an id, so it must not look like one.
export function isValidCheckpointLabel(label: string): boolean {
  return !label.startsWith(CHECKPOINT_ID_PREFIX);
}

export function createCheckpointService(deps: CheckpointServiceDeps): CheckpointService {
  const log = deps.log ?? printLog;

  // a fork its source changed under goes, by id: an imp that took its name
  // since stays
  const removeRefusedFork = async (name: string, forkId: string | null): Promise<void> => {
    if (forkId === null) {
      return;
    }

    await deps.imps.destroyImpId(forkId).catch((error: unknown) => {
      log(`impd: ${name}: a refused fork left the imp: ${readErrorMessage(error)}`);
    });
  };

  const storage = deps.storage;

  const withConsistentDisk = createConsistentDisk({
    storage,
    imps: deps.imps,
    log,
    freezer: deps.freezer,
  });

  const findCheckpointOrThrow = async (imp: ImpRecord, ref: string): Promise<CheckpointRecord> => {
    const checkpoint = await findCheckpoint(deps.db, imp.id, ref);

    if (checkpoint === undefined) {
      throw buildNotFoundError('checkpoint', ref);
    }

    return checkpoint;
  };

  // On ZFS an id can still be taken by the snapshot of a deleted checkpoint
  // that a fork needs; the database alone cannot tell.
  const createWithFreshId = async (impId: string) => {
    for (let attempt = 1; ; attempt += 1) {
      const id = buildCheckpointId(deps.random);

      try {
        const sizeBytes = await storage.createCheckpoint(impId, id);

        return { id, sizeBytes };
      } catch (error) {
        if (!(error instanceof CheckpointIdTakenError) || attempt >= ID_ATTEMPTS) {
          throw error;
        }
      }
    }
  };

  return {
    createCheckpoint: (name, label) =>
      deps.imps.lockImp(name, async (imp) => {
        if (label !== undefined) {
          if (!isValidCheckpointLabel(label)) {
            throw new ORPCError('BAD_REQUEST', {
              message: `a label must not start with ${CHECKPOINT_ID_PREFIX}`,
            });
          }

          const taken = await findCheckpoint(deps.db, imp.id, label);

          if (taken !== undefined) {
            throw buildConflictError('checkpoint', label);
          }
        }

        const started = performance.now();

        await deps.diskBudget.requireRoom(0);

        const created = await withConsistentDisk(imp, 'checkpoint', () =>
          createWithFreshId(imp.id),
        );

        const id = created.id;

        try {
          const checkpoint = await createCheckpoint(deps.db, {
            id,
            impId: imp.id,
            label: label ?? null,
            sizeBytes: created.sizeBytes,
            diskBytes: imp.diskBytes,
          });

          const ms = Math.round(performance.now() - started);

          log(`impd: ${imp.name}: checkpoint ${id} in ${String(ms)}ms`);

          return toApiCheckpoint(checkpoint);
        } catch (error) {
          await storage.removeCheckpoint(imp.id, id);

          throw error;
        }
      }),

    listCheckpoints: async (name) => {
      const imp = await findImpByName(deps.db, name);

      if (imp === undefined) {
        throw buildNotFoundError('imp', name);
      }

      const checkpoints = await listCheckpoints(deps.db, imp.id);

      return checkpoints.map((checkpoint) => toApiCheckpoint(checkpoint));
    },

    // the row goes first: a leftover disk is harmless, a row without a disk
    // is not
    deleteCheckpoint: (name, ref) =>
      deps.imps.lockImp(name, async (imp) => {
        const checkpoint = await findCheckpointOrThrow(imp, ref);

        await removeCheckpoint(deps.db, checkpoint.id);

        await storage.removeCheckpoint(imp.id, checkpoint.id);
      }),

    restoreCheckpoint: (name, ref) =>
      deps.imps.lockImp(name, async (imp) => {
        const checkpoint = await findCheckpointOrThrow(imp, ref);

        if (imp.state === 'creating') {
          throw buildInvalidStateError(
            imp.state,
            ['running', 'sleeping', 'stopped', 'error'],
            'restore',
          );
        }

        const paths = storage.resolveImpPaths(imp.id);
        const wasAwake = imp.state === 'running' || imp.state === 'sleeping';
        const started = performance.now();

        // a failed clone leaves the imp as it was; the halt kills the VM,
        // whose disk and memory go anyway (docs/architecture/storage.md)
        const halted = await storage.restoreCheckpoint(imp.id, checkpoint.id, async () => {
          const stopped = await deps.imps.haltImp(imp, false);

          // the memory holds the old disk's page cache: never pair it with
          // the new disk, even after a crash
          rmSync(paths.snapshotDir, { recursive: true, force: true });

          return stopped;
        });

        // the disk is the checkpoint's now, at the checkpoint's size
        const resized = await updateImpDisk(deps.db, imp.id, {
          diskBytes: checkpoint.diskBytes,
          isGrowPending: false,
        });

        const sized = toLockedImp(halted, resized);

        // a stopped imp boots later, from whatever path: that boot is the
        // restore's
        if (!wasAwake) {
          await writeNextBootCause(deps.db, imp.id, 'restore');
        }

        const booted = wasAwake ? await deps.imps.bootImp(sized) : sized;
        const ms = Math.round(performance.now() - started);

        // the state may be what it was, the disk is not: the stream hears of it
        const restored = await updateImpState(deps.db, booted.id, {
          reason: 'restored',
          detail: { durationMs: ms, trigger: checkpoint.id },
          state: booted.state,
        });

        log(`impd: ${imp.name}: restored ${checkpoint.id} in ${String(ms)}ms`);

        return deps.imps.toApi(restored);
      }),

    forkImp: async (input) => {
      // fail before the new imp exists when the source or checkpoint is wrong
      const source = await deps.imps.lockImp(input.source, async (imp) => {
        const policy = await readEgressPolicy(deps.db, imp.id);

        if (input.checkpoint !== undefined) {
          await findCheckpointOrThrow(imp, input.checkpoint);
        } else if (imp.state === 'creating') {
          throw buildInvalidStateError(
            imp.state,
            ['running', 'sleeping', 'stopped', 'error'],
            'fork',
          );
        }

        const api = await deps.imps.toApi(imp);

        return { imp: api, policy, isIdentityResetPending: imp.isIdentityResetPending };
      });

      // the fork's id once it has one, and whether its source changed
      const made = { forkId: null as string | null, isSourceChanged: false };

      // the name may belong to another imp by now, or to none: the fork must
      // not copy what is there
      const requireSameSource = (imp: Readonly<ImpRecord> | null): void => {
        if (imp === null || imp.id !== source.imp.id) {
          made.isSourceChanged = true;
          throw buildSourceChangedError(input.source);
        }
      };

      const createForkDisk = async (impId: string) => {
        made.forkId = impId;

        try {
          await deps.imps.lockImp(input.source, async (imp) => {
            requireSameSource(imp);

            if (input.checkpoint === undefined) {
              await withConsistentDisk(imp, 'fork', () =>
                storage.createImpDisk(impId, { kind: 'imp', impId: imp.id }),
              );

              return;
            }

            const checkpoint = await findCheckpointOrThrow(imp, input.checkpoint);

            await storage.createImpDisk(impId, {
              kind: 'checkpoint',
              impId: imp.id,
              checkpointId: checkpoint.id,
            });
          });
        } catch (error) {
          if (isImpNotFound(error)) {
            requireSameSource(null);
          }

          throw error;
        }
      };

      try {
        // the source's policy is in the fork's insert: it never runs more open
        const fork = await deps.imps.createImp({
          name: input.name,
          image: source.imp.image,
          vcpus: source.imp.vcpus,
          memoryMib: source.imp.memoryMib,
          maxMemoryMib: source.imp.maxMemoryMib,
          policy: source.policy,
          ...(source.imp.cpu !== undefined && {
            cpuLimit: source.imp.cpu.limit,
            cpuWeight: source.imp.cpu.weight,
          }),
          isIdentityResetPending: source.isIdentityResetPending,
          prepareDisk: createForkDisk,
        });

        return { imp: fork, sourceId: source.imp.id };
      } catch (error) {
        if (made.isSourceChanged) {
          await removeRefusedFork(input.name, made.forkId);
        }

        throw error;
      }
    },
  };
}

// the fork's source was destroyed, or destroyed and made again under its
// name, between its check and its disk copy
function buildSourceChangedError(source: string) {
  return buildConflictError(
    'imp',
    source,
    `imp ${source} changed during the fork; the fork was not made`,
  );
}

function isImpNotFound(error: unknown): boolean {
  if (!(error instanceof ORPCError) || error.code !== 'NOT_FOUND') {
    return false;
  }

  const data: unknown = error.data;

  return typeof data === 'object' && data !== null && Reflect.get(data, 'kind') === 'imp';
}
