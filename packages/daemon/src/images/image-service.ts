import { buildConflictError, buildNotFoundError } from '../api-errors';
import type { Config } from '../config';
import { findImageByName, listImages, removeImage } from '../db/images';
import type { ImageRecord } from '../db/images';
import { countImpsUsingImage } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { DiskBudget } from '../storage/disk-budget';
import type { StorageBackend } from '../storage/storage-backend';
import type { StorageGate } from '../storage/storage-gate';
import type { Builders } from './builder-imps';
import { FALLBACK_DEFAULT_IMAGE, createImageAdds } from './image-adds';
import type { ImageAdds } from './image-adds';
import { createImageBuilds } from './image-builds';
import type { ImageBuilds } from './image-builds';
import { createImageWriter } from './image-writer';

export type ImageService = ImageAdds &
  ImageBuilds & {
    readonly listImages: () => Promise<ImageRecord[]>;
    readonly removeImage: (name: string) => Promise<void>;

    // the named image, else the configured default, else `ubuntu`
    readonly resolveImage: (name?: string) => Promise<ImageRecord>;

    // what resolveImage picks for a create that names no image, if anything
    readonly findDefaultImage: () => Promise<ImageRecord | undefined>;
  };

export interface ImageServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly storage: StorageBackend;

  // a build joins it until the image's row is written, a removal until its
  // rootfs is gone
  readonly storageGate: StorageGate;

  // a build holds room for the unpacked tree and its ext4 file
  readonly diskBudget: Pick<DiskBudget, 'withRoom' | 'withGrowingRoom'>;

  // where an isolated build runs; null until the imps are up
  readonly readBuilders: () => Builders | null;
  readonly log: (message: string) => void;

  // BUILDER_IMAGE_PULL_MS, but for tests; undefined keeps the default
  readonly builderImagePullMs?: number | undefined;

  // starts the limit on the builder image's pull; AbortSignal.timeout by
  // default, and a signal the test aborts in tests
  readonly startPullLimit?: (pullMs: number) => AbortSignal;

  // the environment of images.add's docker calls; impd's own by default
  readonly dockerEnv?: Readonly<Record<string, string>>;

  // the start time of each build images.builds lists; Date.now by default
  readonly now?: () => number;
}

export function createImageService(deps: ImageServiceDeps): ImageService {
  const writer = createImageWriter(deps);

  const findDefaultImage = async (): Promise<ImageRecord | undefined> => {
    for (const name of [deps.config.defaultImage, FALLBACK_DEFAULT_IMAGE]) {
      const image = await findImageByName(deps.db, name);

      if (image !== undefined) {
        return image;
      }
    }

    return undefined;
  };

  const resolveImage = async (name?: string): Promise<ImageRecord> => {
    const image =
      name === undefined ? await findDefaultImage() : await findImageByName(deps.db, name);

    if (image === undefined) {
      throw buildNotFoundError('image', name ?? deps.config.defaultImage);
    }

    return image;
  };

  return {
    ...createImageAdds(deps, writer),
    ...createImageBuilds(deps, writer),
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

      await deps.storageGate.join(async () => {
        await removeImage(deps.db, image.id);

        await writer.removeIdleRootfs(image.digest);
      });
    },
    resolveImage,
    findDefaultImage,
  };
}
