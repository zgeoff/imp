import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EgressPolicySchema } from '@impz/api';
import type {
  BackupRestore,
  BackupRun,
  BackupStatus,
  EgressPolicy,
  Imp,
  ImpState,
} from '@impz/api';
import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import { sendFreeze, sendThaw } from '../agent-client/agent-requests';
import {
  NOT_BACKED_UP_REASON,
  buildConflictError,
  buildNotBackedUpError,
  buildNotFoundError,
} from '../api-errors';
import type { TokenStore } from '../auth/token-store';
import type { Broker } from '../broker/broker-service';
import { buildCheckpointId } from '../checkpoints/checkpoint-service';
import { FREEZE_TIMEOUT_MS } from '../checkpoints/consistent-disk';
import type { DiskFreezer } from '../checkpoints/consistent-disk';
import { createCheckpoint } from '../db/checkpoints';
import { parseStoredPolicy } from '../db/egress';
import { createImage, findImageByDigest, findImageByName } from '../db/images';
import { findImpByName, listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { LockedImp } from '../imps/imp-lock';
import type { Imps } from '../imps/imp-service';
import type { NetworkService } from '../networks/network-service';
import { buildBackoffMs } from '../process/build-backoff-ms';
import { createKeyedMutex } from '../process/keyed-mutex';
import { printLog } from '../process/print-log';
import { writeFileDurably } from '../process/write-file-durably';
import { readErrorMessage } from '../read-error-message';
import { BACKUP_TREE, buildBackupPaths, toDigestHex } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import { CheckpointIdTakenError } from '../storage/storage-backend';
import type { BackupTree, StorageBackend } from '../storage/storage-backend';
import type { StorageGate } from '../storage/storage-gate';
import type { BackupConfig } from './backup-config';
import { BackupManifestSchema } from './backup-manifest';
import type { BackupManifest, ManifestImage, ManifestImp } from './backup-manifest';
import { createRestoredAccess } from './create-restored-access';
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

  // the broker's grant, checked as `impz grant` checks one
  readonly grants: Pick<Broker, 'addGrant'>;

  // the named tokens a restore of all brings back from the database copy
  readonly tokens: Pick<TokenStore, 'createRestored'>;

  // a restored imp's networks, made when missing
  readonly networks: Pick<NetworkService, 'writeMissingNetworks' | 'removeEmptyNetworks'>;
  readonly storage: StorageBackend;
  readonly restic?: Restic;
  readonly freezer?: DiskFreezer;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;

  // a run and a restored image join it: storage no row names yet
  readonly storageGate: StorageGate;

  // a run's copies are thin, but restic's cache grows: none starts past the
  // reserve; a restore holds each file's size while it writes it
  readonly diskBudget: Pick<DiskBudget, 'requireRoom' | 'withRoom'>;
}

// PRECONDITION_FAILED when impd has no repository set
export function buildBackupsOffError(): ORPCError<'PRECONDITION_FAILED', undefined> {
  return new ORPCError('PRECONDITION_FAILED', {
    message: 'backups are off: set IMP_BACKUP_REPOSITORY (docs/guides/configuration.md)',
  });
}

interface RestoredSizes {
  readonly diskBytes: number;
  readonly usedBytes?: number | undefined;
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const log = deps.log ?? printLog;
  const now = deps.now ?? (() => new Date());
  const freezer = deps.freezer ?? { freeze: sendFreeze, thaw: sendThaw };
  const storage = deps.storage;
  const paths = buildBackupPaths(deps.dataDir);
  const restic = deps.restic ?? createRestic({ config: deps.backup, cacheDir: paths.cache });
  const storageGate = deps.storageGate;
  const diskBudget = deps.diskBudget;

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
      const waitMs = buildBackoffMs(retry.failures, { baseMs: RETRY_FIRST_MS, capMs: intervalMs });

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
    writeFileDurably(paths.state, JSON.stringify({ ...readState(), ...change }));
  };

  // Under the imp's lock. A running guest is frozen around the copy; a
  // sleeping one is copied as it is, since waking it to sync would cost
  // more than a crash-consistent disk (docs/architecture/storage/backups.md).
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

  // a sparse disk's blocks, which restic restores sparse again
  const readTreeUsedBytes = (file: string): number => statSync(join(paths.tree, file)).blocks * 512;

  const buildManifest = (
    runId: string,
    copy: DatabaseCopy,
    copies: ReadonlyMap<string, DiskCopy>,
    tree: BackupTree,
    excluded: BackupManifest['excluded'],
    database: BackupManifest['database'],
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
          maxMemoryMib: imp.maxMemoryMib,
          httpPort: imp.httpPort,
          state: copies.get(imp.id)?.state ?? imp.state,
          synced: copies.get(imp.id)?.synced ?? false,
          dir: BACKUP_TREE.buildImpDir(imp.id),
          egressPolicy: parseStoredPolicy(imp.egressPolicy, imp.egressAllow).mode,
          egressAllow: parseStoredPolicy(imp.egressPolicy, imp.egressAllow).allow,
          grants: copy.grants
            .filter((grant) => grant.impId === imp.id && grant.filter === null)
            .map((grant) => grant.secretName),
          filteredGrants: copy.grants.flatMap((grant) =>
            grant.impId === imp.id && grant.filter !== null
              ? [{ secret: grant.secretName, filter: grant.filter }]
              : [],
          ),
          identityResetPending: imp.identityResetPending === 1,
          networks: copy.members
            .filter((member) => member.impId === imp.id)
            .map((member) => member.network),
          disk: BACKUP_TREE.buildDisk(imp.id),
          diskBytes: imp.diskBytes,
          usedBytes: readTreeUsedBytes(BACKUP_TREE.buildDisk(imp.id)),
          checkpoints: copy.checkpoints
            .filter(
              (checkpoint) => checkpoint.impId === imp.id && tree.checkpointIds.has(checkpoint.id),
            )
            .map((checkpoint) => ({
              id: checkpoint.id,
              label: checkpoint.label,
              createdAt: new Date(checkpoint.createdAt),
              disk: BACKUP_TREE.buildCheckpointDisk(imp.id, checkpoint.id),
              diskBytes: checkpoint.diskBytes,
              usedBytes: readTreeUsedBytes(BACKUP_TREE.buildCheckpointDisk(imp.id, checkpoint.id)),
            })),
        })),
      excluded,
      images: copy.images
        .filter((image) => tree.imageDigests.has(image.digest))
        .map((image) => ({
          name: image.name,
          ref: image.ref,
          digest: image.digest,
          source: image.source,
          sourceImp: image.sourceImp,
          sizeBytes: image.sizeBytes,
          dir: BACKUP_TREE.buildImageDir(image.digest),
        })),
      database,
    };
  };

  const runBackup = async (): Promise<BackupRun> => {
    await diskBudget.requireRoom(0);

    return storageGate.join(runJoinedBackup);
  };

  const runJoinedBackup = async (): Promise<BackupRun> => {
    const started = performance.now();
    const runId = Bun.randomUUIDv7();

    await restic.setupRepository();

    // a lock a crashed prune left would block the run
    await restic.unlock();

    // outside the tree: the manifest is what a restore reads, and the
    // database copy would carry whatever later tables hold, so only
    // IMP_BACKUP_DATABASE puts it in
    const copyPath = join(paths.dir, 'db.sqlite');

    const copy = await readDatabaseCopy(deps.db, copyPath);

    const copies = new Map<string, DiskCopy>();

    const skipped: { name: string; reason: string }[] = [];

    // never locked or copied, so no file of theirs reaches the tree
    const excluded = copy.imps
      .filter((imp) => imp.backup === 0)
      .map((imp) => ({ name: imp.name, reason: NOT_BACKED_UP_REASON }));

    for (const imp of copy.imps) {
      if (imp.backup === 0) {
        continue;
      }

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

    const database = deps.backup.database
      ? { file: BACKUP_TREE.database, sizeBytes: statSync(copyPath).size }
      : null;

    const manifest = buildManifest(runId, copy, copies, tree, excluded, database);

    try {
      mkdirSync(paths.tree, { recursive: true });

      await writeTreeDatabase(copyPath, database);

      writeFileSync(join(paths.tree, BACKUP_TREE.manifest), JSON.stringify(manifest, null, 2));

      const names = manifest.imps.map((imp) => imp.name);

      // excluded=<name> lets a restore of the name find the point that
      // says why it holds nothing of it
      const summary = await restic.backup(paths.tree, [
        `run=${runId}`,
        ...names.map((name) => `imp=${name}`),
        ...excluded.map((imp) => `excluded=${imp.name}`),
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
        excluded,
        dataAddedBytes: summary.dataAddedBytes,
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      await tree.close();
    }
  };

  // The copy goes in with the setting on, holding its size from the disk
  // budget while it writes. With it off, the copy a run with it on left in
  // the tree goes, so no later snapshot holds the database.
  const writeTreeDatabase = async (
    copyPath: string,
    database: BackupManifest['database'],
  ): Promise<void> => {
    rmSync(join(paths.tree, dirname(BACKUP_TREE.database)), { recursive: true, force: true });

    if (database === null) {
      return;
    }

    const target = join(paths.tree, database.file);

    await diskBudget.withRoom(database.sizeBytes, () => {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(copyPath, target);
      chmodSync(target, 0o600);

      return Promise.resolve();
    });
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

  // the newest point at or before `at` that holds `name`, or that names it
  // as left out, when one is given
  const findPoint = async (at: Date, name: string | undefined): Promise<ResticSnapshot> => {
    const points = await restic.listSnapshots();

    const point = points.findLast(
      (candidate) =>
        candidate.time.getTime() <= at.getTime() &&
        (name === undefined ||
          candidate.tags.includes(`imp=${name}`) ||
          candidate.tags.includes(`excluded=${name}`)),
    );

    if (point === undefined) {
      throw buildNotFoundError('backup', `${name ?? 'any imp'} at ${at.toISOString()}`);
    }

    return point;
  };

  // An image with the same digest is reused; the name gets a digest suffix
  // when another image has it. It joins the storage gate until its row
  // commits, so a GC never takes the image in between.
  const createRestoredImage = (
    point: ResticSnapshot,
    base: string,
    image: ManifestImage,
    workDir: string,
  ): Promise<string> =>
    storageGate.join(() =>
      diskBudget.withRoom(2 * image.sizeBytes, () =>
        createJoinedImage(point, base, image, workDir),
      ),
    );

  // its own name, else `<name>-<tag>` when another image has it
  const resolveRestoredImageName = async (image: ManifestImage): Promise<string> => {
    const taken = await findImageByName(deps.db, image.name);

    if (taken === undefined) {
      return image.name;
    }

    const fallback = `${image.name.slice(0, 22)}-${buildDigestTag(image.digest)}`;

    const fallbackTaken = await findImageByName(deps.db, fallback);

    if (fallbackTaken !== undefined) {
      throw buildConflictError(
        'image',
        fallback,
        `images ${image.name} and ${fallback} both exist; remove one to restore this image`,
      );
    }

    return fallback;
  };

  const createJoinedImage = async (
    point: ResticSnapshot,
    base: string,
    image: ManifestImage,
    workDir: string,
  ): Promise<string> => {
    const existing = await findImageByDigest(deps.db, image.digest);

    if (existing !== undefined) {
      return existing.name;
    }

    // the name first: a clash on the fallback fails before any storage
    const name = await resolveRestoredImageName(image);

    const dir = join(workDir, image.dir);

    await restic.restore(point.id, join(base, image.dir), dir, []);

    await storage.createImage(image.digest, async (target) => {
      writeFileSync(join(target, 'rootfs.ext4'), '');

      await writeChangedBlocks(join(dir, 'rootfs.ext4'), join(target, 'rootfs.ext4'));

      copyFileSync(join(dir, 'config.json'), join(target, 'config.json'));
    });

    rmSync(dir, { recursive: true, force: true });

    await createImage(deps.db, {
      name,
      ref: image.ref,
      digest: image.digest,
      sizeBytes: image.sizeBytes,
      source: image.source,
      sourceImp: image.sourceImp,
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
    // on the host as ten full disks at once. It holds twice the file's blocks
    // (restic's sparse copy, then the disk), or an older manifest's disk size.
    const writeRestoredFile = (file: string, disk: string, sizes: RestoredSizes) => {
      const bytes = sizes.usedBytes === undefined ? sizes.diskBytes : 2 * sizes.usedBytes;

      return diskBudget.withRoom(bytes, async () => {
        const fileDir = dirname(file);

        await restic.restore(point.id, join(base, fileDir), join(workDir, fileDir), []);

        try {
          await writeChangedBlocks(join(workDir, file), disk);
        } finally {
          rmSync(join(workDir, fileDir), { recursive: true, force: true });
        }
      });
    };

    const writeRestoredDisk = async (impId: string) => {
      created.id = impId;

      await storage.createImpDisk(impId, { kind: 'empty' });

      const disk = storage.resolveImpPaths(impId).disk;

      for (const checkpoint of imp.checkpoints) {
        await writeRestoredFile(checkpoint.disk, disk, checkpoint);

        const made = await createCheckpointDisk(impId);

        await createCheckpoint(deps.db, {
          id: made.id,
          impId,
          label: checkpoint.label,
          sizeBytes: made.sizeBytes,
          createdAt: checkpoint.createdAt,
          diskBytes: checkpoint.diskBytes,
        });
      }

      await writeRestoredFile(imp.disk, disk, imp);
    };

    // a network the restore made goes again when the imp does not come back
    const networks = await deps.networks.writeMissingNetworks(imp.networks);

    try {
      return await deps.imps.createImp({
        name: target.name,
        networkIds: networks.ids,
        image: target.image,
        vcpus: imp.vcpus,
        memoryMib: imp.memoryMib,
        maxMemoryMib: imp.maxMemoryMib ?? undefined,
        httpPort: imp.httpPort,
        policy: resolveEgressPolicy(target.name, imp),
        isIdentityResetPending: imp.identityResetPending,
        start: false,
        prepareDisk: writeRestoredDisk,
      });
    } catch (error) {
      await removeFailedImp(target.name, created.id);

      await deps.networks.removeEmptyNetworks(networks.created);

      throw error;
    }
  };

  // Grants by secret name: a value never leaves its host, so a grant comes
  // back only where a secret of that name exists, and the rest are reported.
  const createRestoredGrants = async (impName: string, imp: ManifestImp) => {
    const skipped: SkippedGrant[] = [];

    const grants = [
      ...imp.grants.map((secret) => ({ secret, filter: undefined })),
      ...imp.filteredGrants,
    ];

    for (const grant of grants) {
      const secret = grant.secret;

      try {
        await deps.grants.addGrant(impName, secret, null, grant.filter);
      } catch (error) {
        skipped.push({ imp: impName, secret, reason: readErrorMessage(error) });
      }
    }

    return skipped;
  };

  // A policy this impd cannot read, from a newer backup, comes back as
  // `none`, with a warning: never more open than it was.
  const resolveEgressPolicy = (name: string, imp: ManifestImp): EgressPolicy => {
    const parsed = EgressPolicySchema.safeParse({ mode: imp.egressPolicy, allow: imp.egressAllow });

    if (parsed.success) {
      return parsed.data;
    }

    log(
      `impd: backup: ${name}: unknown egress policy ${JSON.stringify(imp.egressPolicy)}; restored as none`,
    );

    return { mode: 'none', allow: [] };
  };

  // the tokens and secrets of the backup's database copy, which stay when
  // the imps' restore fails after them: a second restore of all skips them.
  // It holds the copy's size while restic writes and impd reads it.
  const createRestoredDatabase = async (
    point: ResticSnapshot,
    base: string,
    database: NonNullable<BackupManifest['database']>,
    workDir: string,
  ) => {
    const file = requireTreeDatabase(database.file);
    const dir = join(workDir, dirname(file));

    const access = await diskBudget.withRoom(database.sizeBytes, async () => {
      await restic.restore(point.id, join(base, dirname(file)), dir, []);

      return createRestoredAccess(deps.db, deps.tokens, join(workDir, file));
    });

    log(
      `impd: backup: restored ${String(access.tokens.length)} tokens and ${String(access.secrets.length)} secrets from ${point.id}`,
    );

    return access;
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

    // the backup names these imps but holds none of their files
    const notRestorable = manifest.excluded
      .filter((imp) => input.all === true || imp.name === input.name)
      .map((imp) => ({ imp: imp.name, reason: imp.reason }));

    if (input.name !== undefined && chosen.length === 0 && notRestorable.length > 0) {
      throw buildNotBackedUpError(
        input.name,
        `backup ${point.id} (${point.time.toISOString()}) holds none of its files`,
      );
    }

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
      // before the imps, so their grants find the secrets by name
      const database =
        input.all === true && manifest.database !== null
          ? await createRestoredDatabase(point, base, manifest.database, workDir)
          : undefined;

      const imageNames = new Map<string, string>();

      // images before the imps on them; with all, every template too
      const templates = manifest.images.filter((image) => image.source === 'imp');

      const digests = new Set([
        ...chosen.map((imp) => imp.imageDigest),
        ...(input.all === true ? templates.map((image) => image.digest) : []),
      ]);

      for (const digest of digests) {
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

      return {
        imps: restored,
        skippedGrants,
        notRestorable,
        ...(database !== undefined && { database }),
      };
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

// The one path a run writes the copy at: a manifest that names another, as
// one altered could, would restore a file outside the restore's directory
function requireTreeDatabase(database: string): string {
  if (database !== BACKUP_TREE.database) {
    throw new Error(
      `the backup names its database copy at ${database}, not ${BACKUP_TREE.database}`,
    );
  }

  return database;
}

// Eight characters that tell images apart: a docker ID's first, a template's
// last, since its uuidv7 starts with the time (docs/guides/templates.md)
export function buildDigestTag(digest: string): string {
  if (digest.startsWith('imp-')) {
    return digest.replaceAll('-', '').slice(-8);
  }

  return toDigestHex(digest).slice(0, 8);
}
