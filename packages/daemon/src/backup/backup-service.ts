import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BackupRestore, BackupRun, BackupStatus, Imp, ImpState } from '@imp/api';
import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import { sendFreeze, sendThaw } from '../agent-client/agent-requests';
import { buildConflictError, buildNotFoundError } from '../api-errors';
import { EGRESS_POLICIES } from '../broker/broker-front';
import type { Broker } from '../broker/broker-service';
import { FREEZE_TIMEOUT_MS, buildCheckpointId } from '../checkpoints/checkpoint-service';
import type { DiskFreezer } from '../checkpoints/checkpoint-service';
import { createCheckpoint } from '../db/checkpoints';
import { createImage, findImageByDigest, findImageByName } from '../db/images';
import { findImpByName, listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { LockedImp } from '../imps/imp-lock';
import type { Imps } from '../imps/imp-service';
import { createKeyedMutex } from '../imps/keyed-mutex';
import { printLog } from '../process/print-log';
import { readErrorMessage } from '../read-error-message';
import { BACKUP_TREE, buildBackupPaths } from '../storage/data-layout';
import { CheckpointIdTakenError } from '../storage/storage-backend';
import type { BackupTree, StorageBackend } from '../storage/storage-backend';
import type { BackupConfig } from './backup-config';
import { BackupManifestSchema } from './backup-manifest';
import type { BackupManifest, ManifestImage, ManifestImp } from './backup-manifest';
import { readDatabaseCopy } from './read-database-copy';
import type { DatabaseCopy } from './read-database-copy';
import { createRestic, isResticLocked } from './restic';
import type { Restic, ResticSnapshot } from './restic';
import { writeChangedBlocks } from './write-changed-blocks';

const DAY_MS = 24 * 60 * 60 * 1000;

// prune holds restic's exclusive lock, so once a day; a check reads packs
// back from the bucket, so once a week and a part at a time
const PRUNE_EVERY_MS = DAY_MS;
const CHECK_EVERY_MS = 7 * DAY_MS;
const CHECK_SUBSET = '5%';

// Prunes in a row that may meet a lock before the next try waits for a run:
// six ticks of 5 minutes outlast restic's 30 minutes, after which a lock
// left behind is stale and unlock removes it.
const PRUNE_LOCK_TRIES = 6;
const ID_ATTEMPTS = 3;

// the wait after a failed scheduled run, doubled for each failure in a row
// up to the interval: a full bucket must not freeze every guest each tick
const RETRY_FIRST_MS = 5 * 60 * 1000;

const BackupStateSchema = z.object({
  lastRunAt: z.coerce.date().nullable().default(null),
  lastPruneAt: z.coerce.date().nullable().default(null),
  lastCheckAt: z.coerce.date().nullable().default(null),
  lastCheckError: z.string().nullable().default(null),
});

type BackupState = z.infer<typeof BackupStateSchema>;

type SkippedGrant = BackupRestore['skippedGrants'][number];

// an imp's disk in a run, as its lock found it
interface DiskCopy {
  readonly state: ImpState;
  readonly synced: boolean;
}

// the restored imp's name and the image it names
interface RestoreTarget {
  readonly name: string;
  readonly image: string;
}

interface RestoreInput {
  readonly name?: string | undefined;
  readonly all?: boolean | undefined;
  readonly at?: Date | undefined;
  readonly as?: string | undefined;
  readonly merge?: boolean | undefined;
}

export interface BackupService {
  readonly runBackup: () => Promise<BackupRun>;
  readonly readStatus: () => Promise<BackupStatus>;
  readonly restoreBackup: (input: RestoreInput) => Promise<BackupRestore>;
  readonly checkBackups: (subset?: string) => Promise<void>;

  // The schedule's tick: when IMP_BACKUP_INTERVAL_S has passed since the last
  // run, a backup, then a prune once a day and a check once a week. Failures
  // are logged.
  readonly runScheduled: () => Promise<void>;
}

export interface BackupServiceDeps {
  readonly dataDir: string;
  readonly backup: BackupConfig;
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'createImp' | 'destroyImp' | 'lockImp'>;

  // the broker's grant, checked as `imp grant` checks one
  readonly grants: Pick<Broker, 'addGrant'>;
  readonly storage: StorageBackend;
  readonly restic?: Restic;
  readonly freezer?: DiskFreezer;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}

// PRECONDITION_FAILED when impd has no repository set
export function buildBackupsOffError(): ORPCError<'PRECONDITION_FAILED', undefined> {
  return new ORPCError('PRECONDITION_FAILED', {
    message: 'backups are off: set IMP_BACKUP_REPOSITORY (docs/guides/configuration.md)',
  });
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const log = deps.log ?? printLog;
  const now = deps.now ?? (() => new Date());
  const freezer = deps.freezer ?? { freeze: sendFreeze, thaw: sendThaw };
  const storage = deps.storage;
  const paths = buildBackupPaths(deps.dataDir);
  const restic = deps.restic ?? createRestic({ config: deps.backup, cacheDir: paths.cache });

  // a run, a restore, a prune and a check never overlap
  const mutex = createKeyedMutex();
  const runExclusive = <T>(task: () => Promise<T>) => mutex.runExclusive('backup', task);

  // pruneLocks: prunes in a row that found another restic's lock. The next
  // tick tries again, up to PRUNE_LOCK_TRIES, instead of waiting for a run.
  const retry = { failures: 0, lastFailureAt: 0, pruneLocks: 0 };

  const isRunDue = (): boolean => {
    const at = now().getTime();
    const intervalMs = deps.backup.intervalS * 1000;

    if (retry.failures > 0) {
      const waitMs = Math.min(intervalMs, RETRY_FIRST_MS * 2 ** (retry.failures - 1));

      return at - retry.lastFailureAt >= waitMs;
    }

    return at - (readState().lastRunAt?.getTime() ?? 0) >= intervalMs;
  };

  const readState = (): BackupState => {
    try {
      return BackupStateSchema.parse(JSON.parse(readFileSync(paths.state, 'utf8')));
    } catch {
      return BackupStateSchema.parse({});
    }
  };

  const writeState = (change: Partial<BackupState>): void => {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(`${paths.state}.new`, JSON.stringify({ ...readState(), ...change }));
    renameSync(`${paths.state}.new`, paths.state);
  };

  // Under the imp's lock. A running guest is frozen around the copy; a
  // sleeping one is copied as it is, since waking it to sync would cost
  // more than a crash-consistent disk (docs/architecture/backups.md).
  const createCopy = async (imp: LockedImp, runId: string): Promise<DiskCopy> => {
    if (imp.state !== 'running') {
      await storage.createBackupCopy(imp.id, runId, { isReusable: true });

      return { state: imp.state, synced: imp.state === 'stopped' };
    }

    const vsock = storage.resolveImpPaths(imp.id).vsockSocket;

    try {
      await freezer.freeze(vsock, FREEZE_TIMEOUT_MS);
    } catch (error) {
      log(`impd: backup: ${imp.name}: no freeze, copied unsynced: ${readErrorMessage(error)}`);

      await storage.createBackupCopy(imp.id, runId, { isReusable: false });

      return { state: imp.state, synced: false };
    }

    try {
      await storage.createBackupCopy(imp.id, runId, { isReusable: false });
    } finally {
      await freezer.thaw(vsock).catch((error: unknown) => {
        log(
          `impd: backup: ${imp.name}: thaw failed (the agent thaws on its own): ${readErrorMessage(error)}`,
        );
      });
    }

    return { state: imp.state, synced: true };
  };

  const buildManifest = (
    runId: string,
    copy: DatabaseCopy,
    copies: ReadonlyMap<string, DiskCopy>,
    tree: BackupTree,
  ): BackupManifest => {
    const digests = new Map(copy.images.map((image) => [image.id, image.digest]));

    return {
      version: 1,
      runId,
      createdAt: now(),
      imps: copy.imps
        .filter((imp) => tree.impIds.has(imp.id))
        .map((imp) => ({
          id: imp.id,
          name: imp.name,
          imageDigest: digests.get(imp.imageId) ?? '',
          vcpus: imp.vcpus,
          memoryMib: imp.memoryMib,
          httpPort: imp.httpPort,
          state: copies.get(imp.id)?.state ?? imp.state,
          synced: copies.get(imp.id)?.synced ?? false,
          dir: BACKUP_TREE.buildImpDir(imp.id),
          egressPolicy: imp.egressPolicy,
          grants: copy.grants
            .filter((grant) => grant.impId === imp.id)
            .map((grant) => grant.secretName),
          disk: BACKUP_TREE.buildDisk(imp.id),
          checkpoints: copy.checkpoints
            .filter(
              (checkpoint) => checkpoint.impId === imp.id && tree.checkpointIds.has(checkpoint.id),
            )
            .map((checkpoint) => ({
              id: checkpoint.id,
              label: checkpoint.label,
              createdAt: new Date(checkpoint.createdAt),
              disk: BACKUP_TREE.buildCheckpointDisk(imp.id, checkpoint.id),
            })),
        })),
      images: copy.images
        .filter((image) => tree.imageDigests.has(image.digest))
        .map((image) => ({
          name: image.name,
          ref: image.ref,
          digest: image.digest,
          sizeBytes: image.sizeBytes,
          dir: BACKUP_TREE.buildImageDir(image.digest),
        })),
    };
  };

  const runBackup = async (): Promise<BackupRun> => {
    const started = performance.now();
    const runId = Bun.randomUUIDv7();

    await restic.setupRepository();

    // a lock a crashed prune left would block the run
    await restic.unlock();

    // outside the tree: the manifest is what a restore reads, and the
    // database copy would carry whatever later tables hold
    const copy = await readDatabaseCopy(deps.db, join(paths.dir, 'db.sqlite'));

    const copies = new Map<string, DiskCopy>();

    const skipped: { name: string; reason: string }[] = [];

    for (const imp of copy.imps) {
      if (imp.state === 'creating') {
        skipped.push({ name: imp.name, reason: 'being created' });
        continue;
      }

      try {
        const made = await deps.imps.lockImp(imp.name, (locked) =>
          locked.id === imp.id
            ? createCopy(locked, runId)
            : Promise.reject(new Error('replaced since the database copy')),
        );

        copies.set(imp.id, made);
      } catch (error) {
        skipped.push({ name: imp.name, reason: readErrorMessage(error) });

        log(`impd: backup: ${imp.name}: left out: ${readErrorMessage(error)}`);
      }
    }

    const tree = await storage.openBackupTree({
      runId,
      imps: copy.imps
        .filter((imp) => copies.has(imp.id))
        .map((imp) => ({
          impId: imp.id,
          checkpointIds: copy.checkpoints
            .filter((checkpoint) => checkpoint.impId === imp.id)
            .map((checkpoint) => checkpoint.id),
        })),
      imageDigests: copy.images.map((image) => image.digest),
    });

    const manifest = buildManifest(runId, copy, copies, tree);

    try {
      mkdirSync(paths.tree, { recursive: true });
      writeFileSync(join(paths.tree, BACKUP_TREE.manifest), JSON.stringify(manifest, null, 2));

      const names = manifest.imps.map((imp) => imp.name);

      const summary = await restic.backup(paths.tree, [
        `run=${runId}`,
        ...names.map((name) => `imp=${name}`),
      ]);

      writeState({ lastRunAt: now() });

      // a manual run that succeeds ends a scheduled run's backoff too
      retry.failures = 0;

      if (deps.backup.forget) {
        await restic.forget(deps.backup.keep);
      }

      return {
        snapshotId: summary.snapshotId,
        imps: names,
        skipped,
        dataAddedBytes: summary.dataAddedBytes,
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      await tree.close();
    }
  };

  // after an unlock, which drops only stale locks: a crashed run's would
  // otherwise block the exclusive lock prune and check take
  const runCheck = async (subset: string): Promise<void> => {
    await restic.unlock();

    try {
      await restic.check(subset);

      writeState({ lastCheckAt: now(), lastCheckError: null });
    } catch (error) {
      const message = readErrorMessage(error);

      writeState({ lastCheckAt: now(), lastCheckError: message });
      log(`impd: backup: CHECK FAILED, the repository may be damaged: ${message}`);
      throw error;
    }
  };

  const runPrune = async (): Promise<void> => {
    try {
      await restic.unlock();
      await restic.prune();

      retry.pruneLocks = 0;

      writeState({ lastPruneAt: now() });
    } catch (error) {
      retry.pruneLocks = isResticLocked(error) ? retry.pruneLocks + 1 : 0;

      log(`impd: backup: PRUNE FAILED: ${readErrorMessage(error)}`);
    }
  };

  const runMaintenance = async (): Promise<void> => {
    const state = readState();
    const at = now().getTime();

    if (deps.backup.forget && at - (state.lastPruneAt?.getTime() ?? 0) >= PRUNE_EVERY_MS) {
      // a run starts a new series of tries
      retry.pruneLocks = 0;

      await runPrune();
    }

    if (at - (state.lastCheckAt?.getTime() ?? 0) >= CHECK_EVERY_MS) {
      await runCheck(CHECK_SUBSET).catch(() => {});
    }
  };

  // the newest point at or before `at` that holds `name`, when one is given
  const findPoint = async (at: Date, name: string | undefined): Promise<ResticSnapshot> => {
    const points = await restic.listSnapshots();

    const point = points.findLast(
      (candidate) =>
        candidate.time.getTime() <= at.getTime() &&
        (name === undefined || candidate.tags.includes(`imp=${name}`)),
    );

    if (point === undefined) {
      throw buildNotFoundError('backup', `${name ?? 'any imp'} at ${at.toISOString()}`);
    }

    return point;
  };

  // an image with the same digest is reused; the name gets a digest suffix
  // when another image has it
  const createRestoredImage = async (
    point: ResticSnapshot,
    base: string,
    image: ManifestImage,
    workDir: string,
  ): Promise<string> => {
    const existing = await findImageByDigest(deps.db, image.digest);

    if (existing !== undefined) {
      return existing.name;
    }

    const dir = join(workDir, image.dir);

    await restic.restore(point.id, join(base, image.dir), dir, []);

    await storage.createImage(image.digest, async (target) => {
      writeFileSync(join(target, 'rootfs.ext4'), '');

      await writeChangedBlocks(join(dir, 'rootfs.ext4'), join(target, 'rootfs.ext4'));

      copyFileSync(join(dir, 'config.json'), join(target, 'config.json'));
    });

    rmSync(dir, { recursive: true, force: true });

    const taken = await findImageByName(deps.db, image.name);

    const hex = image.digest.replace(/^sha256:/, '').slice(0, 8);
    const name = taken === undefined ? image.name : `${image.name.slice(0, 22)}-${hex}`;

    await createImage(deps.db, {
      name,
      ref: image.ref,
      digest: image.digest,
      sizeBytes: image.sizeBytes,
    });

    return name;
  };

  // ZFS can still hold a deleted checkpoint's id in a snapshot a fork needs
  const createCheckpointDisk = async (impId: string) => {
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

  // Each checkpoint is written over the disk in turn and snapshotted, oldest
  // first, so the checkpoints share every block they did before.
  const createRestoredImp = async (
    point: ResticSnapshot,
    base: string,
    imp: ManifestImp,
    target: RestoreTarget,
    workDir: string,
  ): Promise<Imp> => {
    const created = { id: null as string | null };

    // One file at a time, each gone once written: ten checkpoints never sit
    // on the host as ten full disks at once.
    const writeRestoredFile = async (file: string, disk: string) => {
      const fileDir = dirname(file);

      await restic.restore(point.id, join(base, fileDir), join(workDir, fileDir), []);

      try {
        await writeChangedBlocks(join(workDir, file), disk);
      } finally {
        rmSync(join(workDir, fileDir), { recursive: true, force: true });
      }
    };

    const writeRestoredDisk = async (impId: string) => {
      created.id = impId;

      await storage.createImpDisk(impId, { kind: 'empty' });

      const disk = storage.resolveImpPaths(impId).disk;

      for (const checkpoint of imp.checkpoints) {
        await writeRestoredFile(checkpoint.disk, disk);

        const made = await createCheckpointDisk(impId);

        await createCheckpoint(deps.db, {
          id: made.id,
          impId,
          label: checkpoint.label,
          sizeBytes: made.sizeBytes,
          createdAt: checkpoint.createdAt,
        });
      }

      await writeRestoredFile(imp.disk, disk);

      await deps.db
        .updateTable('imps')
        .set({ egress_policy: resolveEgressPolicy(target.name, imp.egressPolicy) })
        .where('id', '=', impId)
        .execute();
    };

    try {
      return await deps.imps.createImp({
        name: target.name,
        image: target.image,
        vcpus: imp.vcpus,
        memoryMib: imp.memoryMib,
        httpPort: imp.httpPort,
        start: false,
        prepareDisk: writeRestoredDisk,
      });
    } catch (error) {
      await removeFailedImp(target.name, created.id);

      throw error;
    }
  };

  // Grants by secret name: a value never leaves its host, so a grant comes
  // back only where a secret of that name exists, and the rest are reported.
  const createRestoredGrants = async (impName: string, imp: ManifestImp) => {
    const skipped: SkippedGrant[] = [];

    for (const secret of imp.grants) {
      try {
        await deps.grants.addGrant(impName, secret);
      } catch (error) {
        skipped.push({ imp: impName, secret, reason: readErrorMessage(error) });
      }
    }

    return skipped;
  };

  // a policy this impd does not know would leave the broker guessing: an
  // older or newer backup falls back to `open`, with a warning
  const resolveEgressPolicy = (name: string, policy: string): string => {
    if ((EGRESS_POLICIES as readonly string[]).includes(policy)) {
      return policy;
    }

    log(`impd: backup: ${name}: unknown egress policy ${JSON.stringify(policy)}; restored as open`);

    return 'open';
  };

  // only the imp this restore made: a name clash fails before any disk
  const removeFailedImp = async (name: string, impId: string | null): Promise<void> => {
    const found = await findImpByName(deps.db, name);

    if (impId === null || found?.id !== impId) {
      return;
    }

    await deps.imps.destroyImp(name).catch((error: unknown) => {
      log(`impd: backup: ${name}: a failed restore left the imp: ${readErrorMessage(error)}`);
    });
  };

  const runRestore = async (input: RestoreInput): Promise<BackupRestore> => {
    if ((input.all === true) === (input.name !== undefined)) {
      throw new ORPCError('BAD_REQUEST', { message: 'restore one imp by name, or all of them' });
    }

    if (input.all === true && input.as !== undefined) {
      throw new ORPCError('BAD_REQUEST', { message: '`as` renames one imp, not all of them' });
    }

    // a stale lock from a crashed run would block even reading the repository
    await restic.unlock();

    const point = await findPoint(input.at ?? now(), input.name);

    const base = point.paths[0] ?? paths.tree;

    const manifestText = await restic.dump(point.id, join(base, BACKUP_TREE.manifest));

    const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));
    const chosen = manifest.imps.filter((imp) => input.all === true || imp.name === input.name);

    const present = await listImps(deps.db);

    const presentNames = new Set(present.map((imp) => imp.name));

    if (input.all === true && present.length > 0 && input.merge !== true) {
      throw new ORPCError('PRECONDITION_FAILED', {
        message: `impd has ${String(present.length)} imps already; restore --all --merge adds the backup's imps to them`,
      });
    }

    for (const imp of chosen) {
      const name = input.as ?? imp.name;

      if (presentNames.has(name)) {
        throw buildConflictError(
          'imp',
          name,
          `an imp named ${name} exists; restore it --as another name`,
        );
      }
    }

    const workDir = join(paths.restoreDir, Bun.randomUUIDv7());
    const restored: Imp[] = [];
    const skippedGrants: SkippedGrant[] = [];

    try {
      const imageNames = new Map<string, string>();

      for (const digest of new Set(chosen.map((imp) => imp.imageDigest))) {
        const image = manifest.images.find((candidate) => candidate.digest === digest);

        if (image === undefined) {
          throw new Error(`the backup holds no image ${digest}`);
        }

        const imageName = await createRestoredImage(point, base, image, workDir);

        imageNames.set(digest, imageName);
      }

      for (const imp of chosen) {
        const target = { name: input.as ?? imp.name, image: imageNames.get(imp.imageDigest) ?? '' };

        const created = await createRestoredImp(point, base, imp, target, workDir);

        restored.push(created);

        const skipped = await createRestoredGrants(target.name, imp);

        skippedGrants.push(...skipped);

        log(`impd: backup: restored ${target.name} from ${point.id} (${point.time.toISOString()})`);
      }

      return { imps: restored, skippedGrants };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };

  return {
    runBackup: () => runExclusive(runBackup),

    readStatus: async () => {
      const points = await restic.listSnapshots();

      const state = readState();

      return {
        points: points.map((point) => ({
          id: point.id,
          time: point.time,
          imps: point.tags.filter((tag) => tag.startsWith('imp=')).map((tag) => tag.slice(4)),
        })),
        lastRunAt: state.lastRunAt,
        lastPruneAt: state.lastPruneAt,
        lastCheck:
          state.lastCheckAt === null
            ? null
            : {
                at: state.lastCheckAt,
                ...(state.lastCheckError !== null && { error: state.lastCheckError }),
              },
      };
    },

    restoreBackup: (input) => runExclusive(() => runRestore(input)),

    checkBackups: (subset) => runExclusive(() => runCheck(subset ?? CHECK_SUBSET)),

    runScheduled: () =>
      runExclusive(async () => {
        if (!isRunDue()) {
          if (retry.pruneLocks > 0 && retry.pruneLocks < PRUNE_LOCK_TRIES) {
            await runPrune();
          }

          return;
        }

        try {
          const run = await runBackup().catch((error: unknown) => {
            retry.failures += 1;
            retry.lastFailureAt = now().getTime();
            throw error;
          });

          retry.failures = 0;

          const skipped = run.skipped.length > 0 ? `, ${String(run.skipped.length)} left out` : '';

          log(
            `impd: backup: ${run.snapshotId}: ${String(run.imps.length)} imps${skipped}, ${String(run.dataAddedBytes)} bytes added in ${String(run.durationMs)}ms`,
          );
        } finally {
          await runMaintenance();
        }
      }),
  };
}
