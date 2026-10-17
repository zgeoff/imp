import { join } from 'node:path';
import type { StreamRunner } from '../../process/run-stream';
import { CheckpointIdTakenError } from '../storage-backend';
import type {
  MoveSource,
  ReceiveStep,
  ReceivedCheckpoint,
  SendStep,
  StorageBackend,
} from '../storage-backend';
import {
  buildReceiveArgv,
  buildSendArgv,
  findCheckpointSnapshot,
  listCheckpointSnapshots,
} from './zfs-commands';
import type { ZfsCommands, ZfsEntry } from './zfs-commands';

// tries at a checkpoint id no snapshot in the pool has
const ID_ATTEMPTS = 5;

// what the ZFS backend lends its moves: its commands, its lanes, its held
// snapshots and the names of its datasets and their mounts
interface ZfsMoveContext {
  readonly zfs: ZfsCommands;
  readonly streams: StreamRunner;
  readonly datasets: { readonly staging: string; readonly retired: string };
  readonly heldSnapshots: Set<string>;
  readonly runSerial: <T>(task: () => Promise<T>) => Promise<T>;
  readonly runSnapshot: <T>(task: () => Promise<T>) => Promise<T>;
  readonly listAll: () => Promise<ZfsEntry[]>;
  readonly setupMount: (name: string, dir: string, isReadOnly?: boolean) => Promise<void>;
  readonly removeMount: (dir: string) => Promise<void>;
  readonly removeMountDir: (dir: string) => void;
  readonly buildDiskName: (impId: string) => string;
  readonly buildDiskDir: (impId: string) => string;
  readonly buildStagingDir: (name: string) => string;

  // the file in each disk and image dataset
  readonly rootfsFile: string;
}

// A move's side of the ZFS backend: its source as streams or read-only
// clones, and the streams it receives (docs/architecture/storage/moves.md#zfs)
export function createZfsMoves(
  ctx: ZfsMoveContext,
): Pick<StorageBackend, 'openMoveSource' | 'receiveMoveSnapshots'> {
  // Read-only clones of each snapshot, mounted in staging, for a move to an
  // XFS host: the last is the disk, the others the checkpoints in order
  const openMoveFiles = async (
    snapshots: readonly string[],
    removeMoveSnapshot: () => Promise<void>,
  ): Promise<MoveSource> => {
    const moveId = Bun.randomUUIDv7();
    const clones: { name: string; dir: string }[] = [];

    const removeClones = async () => {
      await ctx.runSerial(async () => {
        for (const clone of clones.splice(0).toReversed()) {
          await ctx.removeMount(clone.dir);
          await ctx.zfs.destroy(clone.name);

          ctx.removeMountDir(clone.dir);
        }
      });

      await removeMoveSnapshot();
    };

    try {
      await ctx.runSerial(async () => {
        for (const [index, snapshot] of snapshots.entries()) {
          const name = `${ctx.datasets.staging}/mv-${moveId}-${String(index)}`;
          const dir = ctx.buildStagingDir(name);

          await ctx.zfs.clone(snapshot, name, { readonly: 'on' });

          clones.push({ name, dir });

          await ctx.setupMount(name, dir, true);
        }
      });
    } catch (error) {
      await removeClones();

      throw error;
    }

    const paths = clones.map((clone) => join(clone.dir, ctx.rootfsFile));

    return {
      kind: 'files',
      checkpointPaths: paths.slice(0, -1),
      diskPath: paths.at(-1) ?? '',
      close: removeClones,
    };
  };

  // The snapshots in the order they were made, each incremental from the
  // last one before it on its dataset, a clone stream from its dataset's
  // origin, or else full (docs/architecture/storage/moves.md#zfs)
  const planSendSteps = async (
    entries: readonly ZfsEntry[],
    wanted: ReadonlyMap<string, string | null>,
  ): Promise<SendStep[]> => {
    const origins = new Map(entries.map((entry) => [entry.name, entry.origin]));

    const ordered = entries.filter((entry) => wanted.has(entry.name)).map((entry) => entry.name);

    const stepOf = new Map<string, number>();
    const lastOn = new Map<string, number>();
    const datasetOf = new Map<string, number>();

    const steps: SendStep[] = [];

    for (const snapshot of ordered) {
      const dataset = snapshot.slice(0, snapshot.indexOf('@'));
      const origin = origins.get(dataset) ?? null;
      const earlier = lastOn.get(dataset);
      const fromOrigin = origin === null ? undefined : stepOf.get(origin);
      const base = earlier ?? fromOrigin ?? null;

      if (!datasetOf.has(dataset)) {
        datasetOf.set(dataset, datasetOf.size);
      }

      const baseName = base === null ? null : (ordered[base] ?? null);

      const estimateBytes = await ctx.zfs.estimateSend(snapshot, baseName);

      stepOf.set(snapshot, steps.length);
      lastOn.set(dataset, steps.length);

      steps.push({
        checkpointId: wanted.get(snapshot) ?? null,
        dataset: datasetOf.get(dataset) ?? 0,
        base,
        estimateBytes,
        open: () => ctx.streams.readFrom(buildSendArgv(snapshot, baseName)),
      });
    }

    return steps;
  };

  // a checkpoint id no snapshot in the pool has
  const pickCheckpointId = (
    entries: readonly ZfsEntry[],
    picked: readonly string[],
    buildId: () => string,
  ): string => {
    const tried = { id: '' };

    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      tried.id = buildId();

      if (listCheckpointSnapshots(entries, tried.id).length === 0 && !picked.includes(tried.id)) {
        return tried.id;
      }
    }

    throw new CheckpointIdTakenError(tried.id);
  };

  // Each stream into staging, then the disk's into place and the others
  // retired, as a restore leaves them. What a failure leaves:
  // docs/architecture/storage/moves.md#zfs
  const writeReceived = async (
    impId: string,
    steps: readonly ReceiveStep[],
    readStep: (index: number) => ReadableStream<Uint8Array>,
    buildId: () => string,
  ): Promise<ReceivedCheckpoint[]> => {
    checkReceiveSteps(steps);

    const buildStaged = (dataset: number) =>
      `${ctx.datasets.staging}/mvin-${impId}-${String(dataset)}`;

    const entries = await ctx.runSerial(ctx.listAll);

    const names: string[] = [];

    for (const step of steps) {
      const name = step.isCheckpoint
        ? pickCheckpointId(entries, names, buildId)
        : `mv-${Bun.randomUUIDv7()}`;

      names.push(name);
    }

    // the disk's own snapshot, staged and in place: a GC leaves it until
    // setupReceived destroys it (checkReceiveSteps refused no steps)
    const diskSnapshot = names.at(-1) ?? '';

    const held = [
      `${buildStaged(steps.at(-1)?.dataset ?? 0)}@${diskSnapshot}`,
      `${ctx.buildDiskName(impId)}@${diskSnapshot}`,
    ];

    for (const name of held) {
      ctx.heldSnapshots.add(name);
    }

    try {
      for (const [index, step] of steps.entries()) {
        const dataset = buildStaged(step.dataset);
        const base = step.base === null ? undefined : steps[step.base];
        const isClone = base !== undefined && base.dataset !== step.dataset;

        const origin = isClone
          ? `${buildStaged(base.dataset)}@${names[step.base ?? 0] ?? ''}`
          : null;

        await ctx.streams.writeTo(
          buildReceiveArgv(`${dataset}@${names[index] ?? ''}`, origin),
          readStep(index),
        );
      }

      return await ctx.runSerial(() => setupReceived(impId, steps, names, buildStaged));
    } catch (error) {
      // by listing, so a stream that failed after `zfs recv` committed it
      // goes too; newest first by createtxg, so each clone before its origin
      await ctx.runSerial(async () => {
        const prefix = buildStaged(0).slice(0, -1);

        const listed = await ctx.listAll();

        const left = listed.filter(
          (entry) => entry.type !== 'snapshot' && entry.name.startsWith(prefix),
        );

        for (const dataset of left.toReversed()) {
          await ctx.zfs.destroyRecursive(dataset.name);
        }
      });

      throw error;
    } finally {
      for (const name of held) {
        ctx.heldSnapshots.delete(name);
      }
    }
  };

  const setupReceived = async (
    impId: string,
    steps: readonly ReceiveStep[],
    names: readonly string[],
    buildStaged: (dataset: number) => string,
  ): Promise<ReceivedCheckpoint[]> => {
    const last = steps.at(-1);

    const finalNames = new Map<number, string>();

    for (const step of steps) {
      if (!finalNames.has(step.dataset)) {
        const isDisk = step.dataset === last?.dataset;

        const name = isDisk
          ? ctx.buildDiskName(impId)
          : `${ctx.datasets.retired}/${Bun.randomUUIDv7()}`;

        await ctx.zfs.rename(buildStaged(step.dataset), name);

        finalNames.set(step.dataset, name);
      }
    }

    await ctx.setupMount(ctx.buildDiskName(impId), ctx.buildDiskDir(impId));

    const checkpoints: ReceivedCheckpoint[] = [];

    for (const [index, step] of steps.entries()) {
      const snapshot = `${finalNames.get(step.dataset) ?? ''}@${names[index] ?? ''}`;

      if (step.isCheckpoint) {
        checkpoints.push({
          id: names[index] ?? '',
          sizeBytes: await ctx.zfs.readWritten(snapshot),
        });
      } else {
        // the disk's own snapshot served the stream only
        await ctx.zfs.destroyDeferred(snapshot);
      }
    }

    return checkpoints;
  };

  return {
    openMoveSource: async (impId, checkpointIds, mode) => {
      const disk = `${ctx.buildDiskName(impId)}@mv-${Bun.randomUUIDv7()}`;

      // the imp is stopped and marked: no write lands after this
      await ctx.runSnapshot(() => ctx.zfs.snapshot(disk));

      ctx.heldSnapshots.add(disk);

      const removeMoveSnapshot = async () => {
        ctx.heldSnapshots.delete(disk);

        await ctx.runSerial(() => ctx.zfs.destroyDeferred(disk));
      };

      try {
        const entries = await ctx.runSerial(ctx.listAll);

        const wanted = new Map<string, string | null>([
          ...checkpointIds.map((id): [string, string] => [findCheckpointSnapshot(entries, id), id]),
          [disk, null],
        ]);

        if (mode === 'files') {
          return await openMoveFiles([...wanted.keys()], removeMoveSnapshot);
        }

        const steps = await planSendSteps(entries, wanted);

        return { kind: 'zfs', steps, close: removeMoveSnapshot };
      } catch (error) {
        await removeMoveSnapshot();

        throw error;
      }
    },

    receiveMoveSnapshots: (impId, steps, readStep, buildId) =>
      writeReceived(impId, steps, readStep, buildId),
  };
}

// A peer's plan: each base comes before its step, a dataset's first step is
// full or a clone, every later one incremental from the step before it on
// that dataset, and only the last step is the disk's own
function checkReceiveSteps(steps: readonly ReceiveStep[]): void {
  const lastOn = new Map<number, number>();

  for (const [index, step] of steps.entries()) {
    const base = step.base === null ? undefined : steps[step.base];
    const earlier = lastOn.get(step.dataset);
    const isInOrder = step.base === null || step.base < index;

    const isChained =
      earlier === undefined ? base?.dataset !== step.dataset : step.base === earlier;

    const isLast = index === steps.length - 1;

    if (!isInOrder || !isChained || step.isCheckpoint === isLast) {
      throw new Error(`zfs: step ${String(index)} of the move does not follow on`);
    }

    lastOn.set(step.dataset, index);
  }

  if (steps.length === 0) {
    throw new Error('zfs: a move with no steps');
  }
}
