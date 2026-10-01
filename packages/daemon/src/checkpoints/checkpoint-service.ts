import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
} from '../db/checkpoints';
import type { CheckpointRecord } from '../db/checkpoints';
import { findImpByName } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { ImpService } from '../imps/imp-service';
import { buildImpPaths } from '../storage/data-layout';
import { createReflinkClone } from '../storage/reflink';

// How long the guest stays frozen at most if impd never sends thaw.
const FREEZE_TIMEOUT_MS = 10_000;

// Short, typeable and global, so the existing primary key holds them without
// a migration, and an id never comes back after a delete (unlike v1, v2…).
const CHECKPOINT_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CHECKPOINT_ID_PREFIX = 'cp-';

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
interface DiskFreezer {
  readonly freeze: (vsockPath: string, timeoutMs: number) => Promise<void>;
  readonly thaw: (vsockPath: string) => Promise<void>;
}

export interface CheckpointServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: ImpService;
  readonly log?: (message: string) => void;
  readonly freezer?: DiskFreezer;

  // a reflink clone by default; tests on a non-XFS tmpdir copy instead
  readonly cloneDisk?: (source: string, target: string) => Promise<void>;
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

function toApiCheckpoint(checkpoint: CheckpointRecord): Checkpoint {
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.label !== null && { label: checkpoint.label }),
    ...(checkpoint.sizeBytes !== null && { sizeBytes: checkpoint.sizeBytes }),
  };
}

export function createCheckpointService(deps: CheckpointServiceDeps): CheckpointService {
  const log =
    deps.log ??
    ((message: string) => {
      console.log(message);
    });

  const cloneDisk = deps.cloneDisk ?? createReflinkClone;
  const freezer = deps.freezer ?? { freeze: sendFreeze, thaw: sendThaw };

  const buildCheckpointDisk = (impId: string, checkpointId: string): string =>
    join(buildImpPaths(deps.config.dataDir, impId).checkpointsDir, checkpointId, 'disk.ext4');

  const findCheckpointOrThrow = async (imp: ImpRecord, ref: string): Promise<CheckpointRecord> => {
    const checkpoint = await findCheckpoint(deps.db, imp.id, ref);

    if (checkpoint === undefined) {
      throw buildNotFoundError('checkpoint', ref);
    }

    return checkpoint;
  };

  // A running disk is frozen around the clone (sync + FIFREEZE in the guest).
  // A sleeping one wakes first: its memory image holds unwritten page cache.
  // The caller holds the imp's lock.
  const createConsistentClone = async (found: ImpRecord, target: string, action: string) => {
    const paths = buildImpPaths(deps.config.dataDir, found.id);

    if (found.state === 'stopped' || found.state === 'error') {
      await cloneDisk(paths.disk, target);

      return;
    }

    const imp = found.state === 'sleeping' ? await deps.imps.requireRunningImp(found) : found;

    if (imp.state !== 'running') {
      throw buildInvalidStateError(imp.state, ['running', 'stopped', 'error'], action);
    }

    try {
      await freezer.freeze(paths.vsockSocket, FREEZE_TIMEOUT_MS);

      await cloneDisk(paths.disk, target);
    } finally {
      try {
        await freezer.thaw(paths.vsockSocket);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        log(`impd: ${imp.name}: thaw failed (the agent thaws on its own): ${message}`);
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

        const id = buildCheckpointId();
        const disk = buildCheckpointDisk(imp.id, id);
        const started = performance.now();

        mkdirSync(join(disk, '..'), { recursive: true });

        try {
          await createConsistentClone(imp, disk, 'checkpoint');

          // allocated bytes of the clone; the extents it shares with the imp
          // disk count in full, so this is the most it can cost, not its cost
          const sizeBytes = statSync(disk).blocks * 512;

          const checkpoint = await createCheckpoint(deps.db, {
            id,
            impId: imp.id,
            label: label ?? null,
            sizeBytes,
          });

          const ms = Math.round(performance.now() - started);

          log(`impd: ${imp.name}: checkpoint ${id} in ${String(ms)}ms`);

          return toApiCheckpoint(checkpoint);
        } catch (error) {
          rmSync(join(disk, '..'), { recursive: true, force: true });
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

    // the row goes first: a leftover directory is harmless, a row without a
    // disk is not
    deleteCheckpoint: (name, ref) =>
      deps.imps.lockImp(name, async (imp) => {
        const checkpoint = await findCheckpointOrThrow(imp, ref);

        await removeCheckpoint(deps.db, checkpoint.id);

        rmSync(join(buildCheckpointDisk(imp.id, checkpoint.id), '..'), {
          recursive: true,
          force: true,
        });
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

        const paths = buildImpPaths(deps.config.dataDir, imp.id);
        const wasAwake = imp.state === 'running' || imp.state === 'sleeping';
        const started = performance.now();

        const halted = await deps.imps.haltImp(imp);

        const staged = `${paths.disk}.new`;

        rmSync(staged, { force: true });

        await cloneDisk(buildCheckpointDisk(imp.id, checkpoint.id), staged);

        renameSync(staged, paths.disk);

        // a memory image holds the old disk's page cache; never pair them
        rmSync(paths.snapshotDir, { recursive: true, force: true });

        const restored = wasAwake ? await deps.imps.bootImp(halted) : halted;
        const ms = Math.round(performance.now() - started);

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

      const writeForkDisk = (target: string) =>
        deps.imps.lockImp(input.source, async (imp) => {
          if (input.checkpoint === undefined) {
            await createConsistentClone(imp, target, 'fork');

            return;
          }

          const checkpoint = await findCheckpointOrThrow(imp, input.checkpoint);

          await cloneDisk(buildCheckpointDisk(imp.id, checkpoint.id), target);
        });

      return deps.imps.createImp({
        name: input.name,
        image: source.image,
        vcpus: source.vcpus,
        memoryMib: source.memoryMib,
        prepareDisk: writeForkDisk,
      });
    },
  };
}
