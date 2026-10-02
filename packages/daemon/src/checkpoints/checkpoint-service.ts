import { rmSync } from 'node:fs';
import type { Checkpoint, Imp } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { sendFreeze, sendThaw } from '../agent-client/agent-requests';
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
import { findImpByName, updateImpDisk, updateImpState } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { toLockedImp } from '../imps/imp-lock';
import type { LockedImp } from '../imps/imp-lock';
import type { ImpCheckpointHooks } from '../imps/imp-service';
import { printLog } from '../process/print-log';
import { readErrorMessage } from '../read-error-message';
import { CheckpointIdTakenError } from '../storage/storage-backend';
import type { StorageBackend } from '../storage/storage-backend';

// How long the guest stays frozen at most if impd never sends thaw.
export const FREEZE_TIMEOUT_MS = 10_000;

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

  // disk only: a memory fork would duplicate entropy and IDs (DESIGN 2.4)
  readonly forkImp: (input: ForkInput) => Promise<Imp>;
}

// the agent's freeze and thaw, behind an interface for tests
export interface DiskFreezer {
  readonly freeze: (vsockPath: string, timeoutMs: number) => Promise<void>;
  readonly thaw: (vsockPath: string) => Promise<void>;
}

export interface CheckpointServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: ImpCheckpointHooks;
  readonly storage: StorageBackend;
  readonly log?: (message: string) => void;
  readonly freezer?: DiskFreezer;
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
  const storage = deps.storage;
  const freezer = deps.freezer ?? { freeze: sendFreeze, thaw: sendThaw };

  const findCheckpointOrThrow = async (imp: ImpRecord, ref: string): Promise<CheckpointRecord> => {
    const checkpoint = await findCheckpoint(deps.db, imp.id, ref);

    if (checkpoint === undefined) {
      throw buildNotFoundError('checkpoint', ref);
    }

    return checkpoint;
  };

  // Runs `task` on a consistent disk: a running one is frozen around it (sync
  // + FIFREEZE in the guest), a sleeping one wakes first, since its memory
  // image holds unwritten page cache. The caller holds the imp's lock.
  const withConsistentDisk = async <T>(
    found: LockedImp,
    action: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const paths = storage.resolveImpPaths(found.id);

    if (found.state === 'stopped' || found.state === 'error') {
      return task();
    }

    const imp = found.state === 'sleeping' ? await deps.imps.requireRunningImp(found) : found;

    if (imp.state !== 'running') {
      throw buildInvalidStateError(imp.state, ['running', 'stopped', 'error'], action);
    }

    try {
      await freezer.freeze(paths.vsockSocket, FREEZE_TIMEOUT_MS);

      return await task();
    } finally {
      try {
        await freezer.thaw(paths.vsockSocket);
      } catch (error) {
        const message = readErrorMessage(error);

        log(`impd: ${imp.name}: thaw failed (the agent thaws on its own): ${message}`);
      }
    }
  };

  // On ZFS an id can still be taken by the snapshot of a deleted checkpoint
  // that a fork needs; the database alone cannot tell.
  const createWithFreshId = async (impId: string) => {
    for (let attempt = 1; ; attempt += 1) {
      const id = buildCheckpointId();

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

        // The disk is ready before the halt, so a failed clone leaves the imp
        // as it was. The memory image holds the old disk's page cache: it goes
        // before the swap, so a crash never pairs it with the new disk.
        const halted = await storage.restoreCheckpoint(imp.id, checkpoint.id, async () => {
          const stopped = await deps.imps.haltImp(imp);

          rmSync(paths.snapshotDir, { recursive: true, force: true });

          return stopped;
        });

        // the disk is the checkpoint's now, at the checkpoint's size
        const resized = await updateImpDisk(deps.db, imp.id, {
          diskBytes: checkpoint.diskBytes,
          isGrowPending: false,
        });

        const sized = toLockedImp(halted, resized);
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
        if (input.checkpoint !== undefined) {
          await findCheckpointOrThrow(imp, input.checkpoint);
        } else if (imp.state === 'creating') {
          throw buildInvalidStateError(
            imp.state,
            ['running', 'sleeping', 'stopped', 'error'],
            'fork',
          );
        }

        return deps.imps.toApi(imp);
      });

      const createForkDisk = (impId: string) =>
        deps.imps.lockImp(input.source, async (imp) => {
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

      return deps.imps.createImp({
        name: input.name,
        image: source.image,
        vcpus: source.vcpus,
        memoryMib: source.memoryMib,
        prepareDisk: createForkDisk,
      });
    },
  };
}
