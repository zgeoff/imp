import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildConflictError, buildInvalidStateError } from '../api-errors';
import type { DiskFreezer } from '../checkpoints/consistent-disk';
import { createConsistentDisk } from '../checkpoints/consistent-disk';
import type { Config } from '../config';
import {
  countImageDigestUses,
  createImage,
  findImageById,
  findImageByName,
  updateImage,
} from '../db/images';
import type { ImageRecord } from '../db/images';
import type { ImpDatabase } from '../db/open-database';
import type { ImpCheckpointHooks } from '../imps/imp-service';
import { printLog } from '../process/print-log';
import { buildImagePaths } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import type { StorageBackend } from '../storage/storage-backend';
import type { StorageGate } from '../storage/storage-gate';
import { BUILDER_IMAGE } from './builder-imps';

// A template's digest: no docker image ID ever starts with it
// (docs/guides/templates.md#how-a-template-is-stored)
const TEMPLATE_DIGEST_PREFIX = 'imp-';

export interface TemplateService {
  // An image of the imp's disk, made under its lock; a name made again
  // points at the new disk, and imps made before keep theirs.
  readonly createTemplate: (impName: string, name: string) => Promise<ImageRecord>;
}

interface TemplateServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: Pick<ImpCheckpointHooks, 'lockImp' | 'requireRunningImp'>;
  readonly storage: StorageBackend;

  // the image's storage exists before its row
  readonly storageGate: StorageGate;

  // a template is thin, but none is made past the reserve
  readonly diskBudget: Pick<DiskBudget, 'requireRoom'>;
  readonly log?: (message: string) => void;
  readonly freezer?: DiskFreezer;
}

export function createTemplateService(deps: TemplateServiceDeps): TemplateService {
  const log = deps.log ?? printLog;
  const storage = deps.storage;

  const withConsistentDisk = createConsistentDisk({
    storage,
    imps: deps.imps,
    log,
    freezer: deps.freezer,
  });

  // the source image's docker config, for a backup's manifest
  const writeConfig = async (imageId: string, dir: string): Promise<void> => {
    const image = await findImageById(deps.db, imageId);

    const target = join(dir, 'config.json');

    const config =
      image === undefined ? undefined : buildImagePaths(deps.config.dataDir, image.digest).config;

    if (config !== undefined && existsSync(config)) {
      copyFileSync(config, target);
    } else {
      writeFileSync(target, '{}');
    }
  };

  const writeRow = (
    existing: ImageRecord | undefined,
    image: Readonly<{
      name: string;
      ref: string;
      digest: string;
      sizeBytes: number;
      sourceImp: string;
    }>,
  ): Promise<ImageRecord> => {
    if (existing === undefined) {
      return createImage(deps.db, { ...image, source: 'imp' });
    }

    return updateImage(deps.db, existing.id, image);
  };

  // the disk a template name pointed at before, once no row names it
  const removeReplaced = async (existing: ImageRecord | undefined): Promise<void> => {
    if (existing !== undefined && (await countImageDigestUses(deps.db, existing.digest)) === 0) {
      await storage.removeImage(existing.digest);
    }
  };

  return {
    createTemplate: async (impName, name) => {
      if (name === BUILDER_IMAGE) {
        throw buildConflictError(
          'image',
          name,
          `the image name ${name} is impd's, for its image builders; pick another`,
        );
      }

      await deps.diskBudget.requireRoom(0);

      // joined before the lock, as a backup run does
      return deps.storageGate.join(() =>
        deps.imps.lockImp(impName, async (imp) => {
          if (imp.state === 'creating') {
            throw buildInvalidStateError(
              imp.state,
              ['running', 'sleeping', 'stopped', 'error'],
              'template',
            );
          }

          const existing = await findImageByName(deps.db, name);

          // `imp image add` over a template, or this over a docker image,
          // would change what the name is
          if (existing !== undefined && existing.source !== 'imp') {
            throw buildConflictError(
              'image',
              name,
              `image ${name} is a docker image; give the template a name of its own`,
            );
          }

          const started = performance.now();
          const digest = `${TEMPLATE_DIGEST_PREFIX}${Bun.randomUUIDv7()}`;

          await storage.createImageFromImp(digest, imp.id, {
            hold: (clone) => withConsistentDisk(imp, 'template', clone),
            write: (dir) => writeConfig(imp.imageId, dir),
          });

          const rootfs = buildImagePaths(deps.config.dataDir, digest).rootfs;

          const image = await writeRow(existing, {
            name,
            ref: `imp:${imp.name}`,
            digest,
            sourceImp: imp.name,
            sizeBytes: statSync(rootfs).blocks * 512,
          }).catch(async (error: unknown) => {
            await storage.removeImage(digest);

            throw error;
          });

          await removeReplaced(existing);

          const ms = Math.round(performance.now() - started);

          log(`impd: ${imp.name}: template ${name} in ${String(ms)}ms`);

          return image;
        }),
      );
    },
  };
}
