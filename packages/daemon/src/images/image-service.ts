import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { buildImageRuntimeConfig, deriveImageName } from './image-naming';

const ROOTFS_SIZE = '32G';
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
  readonly getRootfsPath: (image: ImageRecord) => string;
}

export interface ImageServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
}

export function createImageService(deps: ImageServiceDeps): ImageService {
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
    const image = join(work, 'rootfs.ext4');

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

      await runChecked(['truncate', '-s', ROOTFS_SIZE, image]);
      await runChecked(['mkfs.ext4', '-q', '-F', '-L', 'imp-root', '-d', root, image]);

      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.config, JSON.stringify(ociConfig ?? {}, null, 2));
      renameSync(image, paths.rootfs);
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
      rmSync(buildImagePaths(deps.config.dataDir, digest).dir, { recursive: true, force: true });
    }
  };

  const createImageFromRef = async (ref: string, name?: string): Promise<ImageRecord> => {
    assertImageRef(ref);

    const imageName = NameSchema.parse(name ?? deriveImageName(ref));

    const inspect = await readInspect(ref);

    if (inspect === undefined) {
      throw new Error(`docker image inspect ${ref}: no result`);
    }

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

      await removeImage(deps.db, image.id);
      await removeUnusedRootfs(image.digest);
    },
    resolveImage,
    seedDefaultImage: async () => {
      const images = await listImages(deps.db);

      if (images.length === 0) {
        await createImageFromRef(SEED_REF, FALLBACK_DEFAULT_IMAGE);
      }
    },
    getRootfsPath: (image) => buildImagePaths(deps.config.dataDir, image.digest).rootfs,
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

function readDiskUsage(path: string): number {
  return statSync(path).blocks * 512;
}
