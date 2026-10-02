import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageRefSchema, NameSchema } from '@imp/api';
import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import { buildConflictError, buildNotFoundError } from '../api-errors';
import type { Config } from '../config';
import {
  countImageDigestUses,
  createImage,
  findImageByName,
  listImages,
  removeImage,
  updateImage,
} from '../db/images';
import type { ImageRecord } from '../db/images';
import { countImpsUsingImage } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { runChecked, runCommand } from '../process/run-command';
import { buildImagePaths } from '../storage/data-layout';
import type { StorageBackend } from '../storage/storage-backend';
import { createStorageGate } from '../storage/storage-gate';
import type { StorageGate } from '../storage/storage-gate';
import { buildImageRuntimeConfig, deriveImageName } from './image-naming';

const GIB = 1024 ** 3;

// An image's ext4 holds its files and room to spare; each imp disk grows past
// it (docs/architecture/storage.md#disk-sizes)
const ROOTFS_MIN_BYTES = 4 * GIB;
const ROOTFS_SPARE_BYTES = 2 * GIB;

// mkfs.ext4's default: one inode per 16 KiB
const BYTES_PER_INODE = 16_384;
const FALLBACK_DEFAULT_IMAGE = 'ubuntu';
const SEED_REF = 'ubuntu:24.04';
const InspectSchema = z.array(z.object({ Id: z.string(), Config: z.unknown() })).length(1);

export interface ImageService {
  readonly addImage: (ref: string, name?: string) => Promise<ImageRecord>;
  readonly buildImage: (
    contextDir: string,
    name: string,
    dockerfile?: string,
  ) => Promise<ImageRecord>;
  readonly listImages: () => Promise<ImageRecord[]>;
  readonly removeImage: (name: string) => Promise<void>;

  // the named image, else the configured default, else `ubuntu`
  readonly resolveImage: (name?: string) => Promise<ImageRecord>;

  // adds ubuntu:24.04 as `ubuntu` when there are no images at all
  readonly seedDefaultImage: () => Promise<void>;
}

export interface ImageServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly storage: StorageBackend;

  // a build joins it until the image's row is written, a removal until its
  // rootfs is gone
  readonly storageGate?: StorageGate;
}

export function createImageService(deps: ImageServiceDeps): ImageService {
  const storageGate = deps.storageGate ?? createStorageGate();

  // one build per docker image ID at a time
  const building = new Map<string, Promise<number>>();

  const readInspect = async (ref: string) => {
    const first = await runCommand(['docker', 'image', 'inspect', ref]);

    if (first.exitCode === 0) {
      return InspectSchema.parse(JSON.parse(first.stdout))[0];
    }

    await runChecked(['docker', 'pull', '--quiet', ref]);

    const stdout = await runChecked(['docker', 'image', 'inspect', ref]);

    return InspectSchema.parse(JSON.parse(stdout))[0];
  };

  // OCI image → sparse ext4 (DESIGN 2.5); returns the rootfs size on disk
  const buildRootfs = async (ref: string, digest: string, ociConfig: unknown): Promise<number> => {
    const paths = buildImagePaths(deps.config.dataDir, digest);

    if (existsSync(paths.rootfs)) {
      return readDiskUsage(paths.rootfs);
    }

    const work = join(deps.config.dataDir, 'images', `.build-${Bun.randomUUIDv7()}`);
    const root = join(work, 'root');

    mkdirSync(root, { recursive: true, mode: 0o755 });

    const created = await runChecked(['docker', 'create', ref, '/bin/true']);

    const containerId = created.trim();

    try {
      // root here, so tar keeps numeric owners as they are in the image
      await runChecked([
        'bash',
        '-o',
        'pipefail',
        '-c',
        'docker export "$1" | tar --numeric-owner --xattrs -xpf - -C "$2"',
        'export',
        containerId,
        root,
      ]);

      mkdirSync(join(root, 'etc', 'imp'), { recursive: true });

      writeFileSync(
        join(root, 'etc', 'imp', 'image.json'),
        JSON.stringify(buildImageRuntimeConfig(ociConfig)),
      );

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
    } finally {
      await runCommand(['docker', 'rm', '-f', containerId]);

      rmSync(work, { recursive: true, force: true });
    }

    return readDiskUsage(paths.rootfs);
  };

  const buildRootfsOnce = async (
    ref: string,
    digest: string,
    ociConfig: unknown,
  ): Promise<number> => {
    const inFlight = building.get(digest);

    if (inFlight !== undefined) {
      return inFlight;
    }

    const promise = buildRootfs(ref, digest, ociConfig);

    building.set(digest, promise);

    try {
      return await promise;
    } finally {
      building.delete(digest);
    }
  };

  // drops an image directory no image row points at any more
  const removeUnusedRootfs = async (digest: string): Promise<void> => {
    const uses = await countImageDigestUses(deps.db, digest);

    if (uses === 0) {
      await deps.storage.removeImage(digest);
    }
  };

  const createImageFromRef = async (ref: string, name?: string): Promise<ImageRecord> => {
    assertImageRef(ref);

    const imageName = NameSchema.parse(name ?? deriveImageName(ref));

    const inspect = await readInspect(ref);

    if (inspect === undefined) {
      throw new Error(`docker image inspect ${ref}: no result`);
    }

    return storageGate.join(async () => {
      const sizeBytes = await buildRootfsOnce(ref, inspect.Id, inspect.Config);
      const existing = await findImageByName(deps.db, imageName);

      if (existing === undefined) {
        return createImage(deps.db, { name: imageName, ref, digest: inspect.Id, sizeBytes });
      }

      if (existing.digest === inspect.Id) {
        return existing;
      }

      const updated = await updateImage(deps.db, existing.id, {
        ref,
        digest: inspect.Id,
        sizeBytes,
      });

      await removeUnusedRootfs(existing.digest);

      return updated;
    });
  };

  const resolveImage = async (name?: string): Promise<ImageRecord> => {
    const candidates =
      name === undefined ? [deps.config.defaultImage, FALLBACK_DEFAULT_IMAGE] : [name];

    for (const candidate of candidates) {
      const image = await findImageByName(deps.db, candidate);

      if (image !== undefined) {
        return image;
      }
    }

    throw buildNotFoundError('image', name ?? deps.config.defaultImage);
  };

  return {
    addImage: createImageFromRef,
    buildImage: async (contextDir, name, dockerfile) => {
      if (!contextDir.startsWith('/')) {
        throw new ORPCError('BAD_REQUEST', {
          message: `build context ${JSON.stringify(contextDir)} is not an absolute path`,
        });
      }

      // The CLI sends a path on its own machine. impd sees it only when the
      // two share a filesystem (the dev container mounts the repo); a host
      // running the release image does not.
      if (!existsSync(contextDir)) {
        throw new ORPCError('BAD_REQUEST', {
          message: `build context ${contextDir} does not exist on the impd host; build the image there and use \`imp image add\``,
        });
      }

      const tag = `imp/${NameSchema.parse(name)}:latest`;
      const fileArgs = dockerfile === undefined ? [] : ['-f', join(contextDir, dockerfile)];

      await runChecked(['docker', 'build', '--quiet', '-t', tag, ...fileArgs, contextDir]);

      return createImageFromRef(tag, name);
    },
    listImages: () => listImages(deps.db),
    removeImage: async (name) => {
      const image = await findImageByName(deps.db, name);

      if (image === undefined) {
        throw buildNotFoundError('image', name);
      }

      const users = await countImpsUsingImage(deps.db, image.id);

      if (users > 0) {
        throw buildConflictError('image', name, `image ${name} is used by ${String(users)} imp(s)`);
      }

      await storageGate.join(async () => {
        await removeImage(deps.db, image.id);
        await removeUnusedRootfs(image.digest);
      });
    },
    resolveImage,
    seedDefaultImage: async () => {
      const images = await listImages(deps.db);

      if (images.length === 0) {
        await createImageFromRef(SEED_REF, FALLBACK_DEFAULT_IMAGE);
      }
    },
  };
}

// The contract validates refs already; this guards every other caller, since
// the ref goes into docker's argv and a leading `-` would read as a flag.
function assertImageRef(ref: string): void {
  if (!ImageRefSchema.safeParse(ref).success) {
    throw new ORPCError('BAD_REQUEST', {
      message: `invalid image reference ${JSON.stringify(ref)}`,
    });
  }
}

interface RootfsPlan {
  readonly bytes: number;

  // null leaves mkfs.ext4 its default count
  readonly inodes: number | null;
}

// The rootfs size for a tree: its bytes and a fifth more, plus 2 GiB, in
// whole GiB and at least 4 GiB. A tree of many small files gets twice its
// inode count, since a grow adds inodes only in proportion to the size.
export function planRootfs(tree: Readonly<{ bytes: number; inodes: number }>): RootfsPlan {
  const wanted = Math.ceil((tree.bytes * 1.2 + ROOTFS_SPARE_BYTES) / GIB) * GIB;
  const bytes = Math.max(ROOTFS_MIN_BYTES, wanted);
  const inodes = tree.inodes * 2;

  return { bytes, inodes: inodes > bytes / BYTES_PER_INODE ? inodes : null };
}

// bytes on disk and files in the unpacked image
async function readTreeUsage(root: string): Promise<{ bytes: number; inodes: number }> {
  const bytes = await runChecked(['du', '-s', '-B1', root]);
  const inodes = await runChecked(['du', '-s', '--inodes', root]);

  return { bytes: parseDuCount(bytes), inodes: parseDuCount(inodes) };
}

function parseDuCount(stdout: string): number {
  const count = Number(stdout.split(/\s/)[0]);

  if (!Number.isSafeInteger(count)) {
    throw new TypeError(`du printed ${stdout}`);
  }

  return count;
}

function readDiskUsage(path: string): number {
  return statSync(path).blocks * 512;
}
