import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NameSchema } from '@imp/api';
import type { ImageBuildPhase } from '@imp/api';
import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import { buildConflictError } from '../api-errors';
import type { Config } from '../config';
import { countImageDigestUses, createImage, findImageByName, updateImage } from '../db/images';
import type { ImageRecord } from '../db/images';
import type { ImpDatabase } from '../db/open-database';
import { createKeyedMutex } from '../process/keyed-mutex';
import { runChecked, runCommand } from '../process/run-command';
import { createSingleFlight } from '../process/single-flight';
import { readErrorMessage } from '../read-error-message';
import { buildImagePaths, buildImagesDir } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import type { StorageBackend } from '../storage/storage-backend';
import type { StorageGate } from '../storage/storage-gate';
import { BUILDER_IMAGE } from './builder-imps';
import { writeGuestTree } from './guest-build';
import type { GuestExec } from './guest-exec';
import { buildImageRuntimeConfig } from './image-naming';
import { pickRepoDigest } from './image-pin';
import { planRootfs, planRootfsOverhead } from './rootfs-plan';
import { runDocker, runDockerChecked } from './run-docker';
import { writeExportedTree } from './unpack-export';
import { writeImageConfig } from './write-image-config';

const RepoDigestsSchema = z.array(z.string()).nullish();

const InspectSchema = z.tuple([
  z.object({
    Id: z.string(),
    Config: z.unknown(),
    Size: z.number().optional(),
    RepoDigests: RepoDigestsSchema,
  }),
]);

interface HostImageOptions {
  readonly onResolved?: ((reference: string) => void) | undefined;

  // kills the inspect and the pull when it aborts
  readonly signal?: AbortSignal | undefined;

  // once the inspect and any pull are done, before the rootfs is written
  readonly onPulled?: (() => void) | undefined;
  readonly setPhase?: ((phase: ImageBuildPhase) => void) | undefined;
}

export interface ImageWriter {
  // an image of the host's engine, pulled there when it lacks it
  readonly createImageOnHost: (
    ref: string,
    imageName: string,
    options?: Readonly<HostImageOptions>,
  ) => Promise<ImageRecord>;

  // a builder's export, streamed out into a rootfs and a row
  readonly writeGuestImage: (
    exec: GuestExec,
    imageName: string,
    ref: string,
    signal: AbortSignal,
  ) => Promise<ImageRecord>;

  // drops the rootfs of a digest once no row and no guest write uses it
  readonly removeIdleRootfs: (digest: string) => Promise<void>;
}

interface ImageWriterDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly storage: StorageBackend;

  // a build joins it until the image's row is written, a removal until its
  // rootfs is gone
  readonly storageGate: StorageGate;

  // a build holds room for the unpacked tree and its ext4 file
  readonly diskBudget: Pick<DiskBudget, 'withRoom' | 'withGrowingRoom'>;
  readonly log: (message: string) => void;

  // the environment of images.add's docker calls; impd's own by default
  readonly dockerEnv?: Readonly<Record<string, string>>;
}

// Images land here, whether an add or a build made them: each digest's
// rootfs once, then the image row by its name.
export function createImageWriter(deps: ImageWriterDeps): ImageWriter {
  const storageGate = deps.storageGate;

  // one build per docker image ID at a time
  const building = createSingleFlight<number>();

  // per guest digest, the writers whose row is not written yet, and whether
  // one made its rootfs or a removal waits on them: the last to end removes
  // it if no row took it, under a lock, so no new writer finds it as it goes
  const guestWriters = new Map<string, number>();
  const freshRootfs = new Set<string>();

  const guestRootfsLock = createKeyedMutex();
  const docker = { env: deps.dockerEnv };

  const readInspect = async (ref: string, signal: AbortSignal | undefined) => {
    const options = { ...docker, ...(signal !== undefined && { signal }) };

    const first = await runDocker(['image', 'inspect', ref], options);

    if (first.exitCode === 0) {
      return InspectSchema.parse(JSON.parse(first.stdout))[0];
    }

    await runDockerChecked(['pull', '--quiet', ref], options);

    signal?.throwIfAborted();

    const stdout = await runDockerChecked(['image', 'inspect', ref], options);

    return InspectSchema.parse(JSON.parse(stdout))[0];
  };

  // A fresh directory for an unpacked tree. 0700: a host user must not
  // reach the tree, whose setuid and capability files are live while it is
  // unpacked.
  const makeWorkDir = (): { work: string; root: string } => {
    const images = buildImagesDir(deps.config.dataDir);
    const work = join(images, `.build-${Bun.randomUUIDv7()}`);
    const root = join(work, 'root');

    mkdirSync(images, { recursive: true });
    mkdirSync(work, { mode: 0o700 });
    mkdirSync(root, { mode: 0o755 });

    return { work, root };
  };

  // an unpacked tree → sparse ext4
  // (docs/architecture/storage.md#images-any-oci-image); returns the rootfs
  // size on disk
  const writeRootfs = async (root: string, digest: string, ociConfig: unknown): Promise<number> => {
    writeImageConfig(root, JSON.stringify(buildImageRuntimeConfig(ociConfig)));

    const usage = await readTreeUsage(root);

    const plan = planRootfs(usage);

    // the backend gives the directory: on ZFS it is a dataset of its own
    await deps.storage.createImage(digest, async (dir) => {
      const image = join(dir, 'rootfs.ext4');

      await runChecked(['truncate', '-s', String(plan.bytes), image]);

      // the default features keep resize_inode, which an online grow needs
      await runChecked([
        'mkfs.ext4',
        '-q',
        '-F',
        '-L',
        'imp-root',
        ...(plan.inodes === null ? [] : ['-N', String(plan.inodes)]),
        '-d',
        root,
        image,
      ]);

      writeFileSync(join(dir, 'config.json'), JSON.stringify(ociConfig ?? {}, null, 2));
    });

    return readDiskUsage(buildImagePaths(deps.config.dataDir, digest).rootfs);
  };

  // an image of the host's engine → its rootfs, unless it has one
  const buildRootfs = async (ref: string, digest: string, ociConfig: unknown): Promise<number> => {
    const paths = buildImagePaths(deps.config.dataDir, digest);

    if (existsSync(paths.rootfs)) {
      return readDiskUsage(paths.rootfs);
    }

    const created = await runDockerChecked(['create', ref, '/bin/true'], docker);

    const containerId = created.trim();

    // the work directory only once the create has passed, so a refused
    // create leaves none behind
    try {
      const workDir = makeWorkDir();

      try {
        await writeExportedTree(containerId, workDir.root);

        return await writeRootfs(workDir.root, digest, ociConfig);
      } finally {
        rmSync(workDir.work, { recursive: true, force: true });
      }
    } finally {
      await runCommand(['docker', 'rm', '-f', containerId]);
    }
  };

  // one rootfs per digest at a time; a second build of it waits for the first
  const createRootfsOnce = (digest: string, create: () => Promise<number>) =>
    building.run(digest, create);

  // the image row by its name: made, or moved to the new digest, whose old
  // rootfs goes when nothing else uses it
  const writeImageRow = async (
    imageName: string,
    ref: string,
    digest: string,
    sizeBytes: number,
  ): Promise<ImageRecord> => {
    const existing = await findImageByName(deps.db, imageName);

    requireDockerImage(existing);

    if (existing === undefined) {
      return createImage(deps.db, { name: imageName, ref, digest, sizeBytes });
    }

    if (existing.digest === digest) {
      return existing;
    }

    const updated = await updateImage(deps.db, existing.id, { ref, digest, sizeBytes });

    await removeIdleRootfs(existing.digest);

    return updated;
  };

  // drops an image directory no image row points at any more
  const removeUnusedRootfs = async (digest: string): Promise<void> => {
    const uses = await countImageDigestUses(deps.db, digest);

    if (uses === 0) {
      await deps.storage.removeImage(digest);
    }
  };

  // removeUnusedRootfs, but while a guest build of the digest counts, which
  // may have found the rootfs and not yet written its row, the last such
  // build decides
  const removeIdleRootfs = (digest: string): Promise<void> =>
    guestRootfsLock.runExclusive(digest, async () => {
      if (guestWriters.has(digest)) {
        freshRootfs.add(digest);

        return;
      }

      await removeUnusedRootfs(digest);
    });

  // An image of the host's engine, pulled there when it lacks it: the
  // builders' own image, and every add and build under
  // IMP_BUILD_ISOLATION=host
  const createImageOnHost = async (
    ref: string,
    imageName: string,
    options: Readonly<HostImageOptions> = {},
  ): Promise<ImageRecord> => {
    const inspect = await readInspect(ref, options.signal);

    options.onPulled?.();
    const resolved = pickRepoDigest(ref, inspect.RepoDigests ?? []);

    if (resolved !== null) {
      options.onResolved?.(resolved);
    }

    // the unpack is shared with any add of the same image: no client stops it
    options.setPhase?.('unpack');

    // the tree unpacked, and the ext4 file written from it with its journal
    const treeBytes = inspect.Size ?? 0;
    const buildBytes = 2 * treeBytes + planRootfsOverhead(treeBytes);
    const withRoom = deps.diskBudget.withRoom;

    return withRoom(buildBytes, () =>
      storageGate.join(async () => {
        const sizeBytes = await createRootfsOnce(inspect.Id, () =>
          buildRootfs(ref, inspect.Id, inspect.Config),
        );

        return writeImageRow(imageName, ref, inspect.Id, sizeBytes);
      }),
    );
  };

  const writeGuestRootfsAndRow = async (guest: Readonly<GuestRootfs>): Promise<ImageRecord> => {
    const digest = guest.digest;
    const rootfs = buildImagePaths(deps.config.dataDir, digest).rootfs;

    await guestRootfsLock.runExclusive(digest, () => {
      guestWriters.set(digest, (guestWriters.get(digest) ?? 0) + 1);

      return Promise.resolve();
    });

    try {
      guest.signal.throwIfAborted();

      const sizeBytes = await createRootfsOnce(digest, () => {
        if (existsSync(rootfs)) {
          return Promise.resolve(readDiskUsage(rootfs));
        }

        // marked first: a write that fails after it published the rootfs, as
        // a ZFS mount can, still leaves it to the cleanup below
        freshRootfs.add(digest);

        return writeRootfs(guest.root, digest, guest.config);
      });

      // a cancel during mkfs.ext4 commits nothing
      guest.signal.throwIfAborted();

      return await writeImageRow(guest.imageName, guest.ref, digest, sizeBytes);
    } finally {
      await guestRootfsLock.runExclusive(digest, async () => {
        const left = (guestWriters.get(digest) ?? 1) - 1;

        if (left > 0) {
          guestWriters.set(digest, left);

          return;
        }

        guestWriters.delete(digest);

        if (!freshRootfs.delete(digest)) {
          return;
        }

        // logged, so the error that ended the write or the row is the one
        // its caller gets
        try {
          await removeUnusedRootfs(digest);
        } catch (error) {
          deps.log(
            `impd: image ${guest.imageName}: could not remove the unused rootfs of ${digest}: ${readErrorMessage(error)}`,
          );
        }
      });
    }
  };

  // the built image, streamed out of its builder into a rootfs and a row
  const writeGuestImage = (
    exec: GuestExec,
    imageName: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<ImageRecord> => {
    const maxBytes = deps.config.build.imageMaxBytes;

    // the tree unpacked, and the ext4 file written from it, held as the
    // export grows
    return deps.diskBudget.withGrowingRoom((grow) =>
      storageGate.join(async () => {
        const workDir = makeWorkDir();
        const root = workDir.root;

        try {
          const exported = await writeGuestTree(
            exec,
            root,
            { maxBytes, maxFiles: deps.config.build.imageMaxFiles },
            signal,
            grow,
          );

          return await writeGuestRootfsAndRow({
            root,
            digest: exported.digest,
            config: exported.config,
            imageName,
            ref,
            signal,
          });
        } finally {
          rmSync(workDir.work, { recursive: true, force: true });
        }
      }),
    );
  };

  return { createImageOnHost, writeGuestImage, removeIdleRootfs };
}

// a name a client may give an image: BUILDER_IMAGE is impd's
export function requireClientImageName(name: string): string {
  const imageName = NameSchema.parse(name);

  if (imageName === BUILDER_IMAGE) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the image name ${BUILDER_IMAGE} is impd's, for its image builders; pick another`,
    });
  }

  return imageName;
}

// A template is never rebuilt from docker: its name is made again from an
// imp (docs/guides/templates.md)
export function requireDockerImage(existing: ImageRecord | undefined): void {
  if (existing?.source === 'imp') {
    throw buildConflictError(
      'image',
      existing.name,
      `image ${existing.name} is a template; make it again from an imp, or pick another name`,
    );
  }
}

// a builder's export, unpacked at root, on its way to a rootfs and a row
interface GuestRootfs {
  readonly root: string;
  readonly digest: string;
  readonly config: unknown;
  readonly imageName: string;
  readonly ref: string;
  readonly signal: AbortSignal;
}

// bytes on disk and files in the unpacked image
async function readTreeUsage(root: string): Promise<{ bytes: number; inodes: number }> {
  const bytes = await runChecked(['du', '-s', '-B1', root]);
  const inodes = await runChecked(['du', '-s', '--inodes', root]);

  return { bytes: parseDuCount(bytes), inodes: parseDuCount(inodes) };
}

// the count du prints before its path
export function parseDuCount(stdout: string): number {
  const count = Number(stdout.split(/\s/)[0]);

  if (!Number.isSafeInteger(count)) {
    throw new TypeError(`du printed ${stdout}`);
  }

  return count;
}

function readDiskUsage(path: string): number {
  return statSync(path).blocks * 512;
}
