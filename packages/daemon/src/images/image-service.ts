import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { ImageRefSchema, NameSchema } from '@imp/api';
import {
  BuildContextError,
  MissingDockerfileError,
  countTarBytes,
  listContextEntries,
  readBuildContext,
  writeBuildContext,
} from '@imp/local-tar';
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
import { checkReferenceRegistry } from '../docker-proxy/rules';
import { runChecked, runCommand } from '../process/run-command';
import { buildImagePaths, buildUploadsDir } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import type { StorageBackend } from '../storage/storage-backend';
import type { StorageGate } from '../storage/storage-gate';
import { DockerBuildError, runDockerBuild } from './docker-build';
import { checkDockerfile, renderPinnedDockerfile } from './dockerfile-check';
import type { ExternalImage } from './dockerfile-check';
import { DockerfileError } from './dockerfile-error';
import { buildImageRuntimeConfig, deriveImageName } from './image-naming';
import {
  PIN_INSPECT_FORMAT,
  PinInspectSchema,
  formatPinFailure,
  formatPlatform,
  normalizePlatform,
  pickRepoDigest,
  readImageStore,
} from './image-pin';
import type { ImageStore, Pin, PinInspect } from './image-pin';
import { writeExportedTree } from './unpack-export';
import { writeContextTar } from './write-context-tar';

const GIB = 1024 ** 3;

// An image's ext4 holds its files and room to spare; each imp disk grows past
// it (docs/architecture/storage.md#disk-sizes)
const ROOTFS_MIN_BYTES = 4 * GIB;
const ROOTFS_SPARE_BYTES = 2 * GIB;

// mkfs.ext4's default: one inode per 16 KiB
const BYTES_PER_INODE = 16_384;
const FALLBACK_DEFAULT_IMAGE = 'ubuntu';

// the largest Dockerfile impd reads for its FROM lines
const DOCKERFILE_MAX_BYTES = 1024 ** 2;

// the tail of a failed pull's message the client gets
const FAILURE_MAX_CHARS = 4000;
const SEED_REF = 'ubuntu:24.04';

const InspectSchema = z
  .array(
    z.object({
      Id: z.string(),
      Config: z.unknown(),
      Size: z.number().optional(),
    }),
  )
  .length(1);

export interface ImageService {
  readonly addImage: (ref: string, name?: string) => Promise<ImageRecord>;
  readonly buildImage: (
    contextDir: string,
    name: string,
    dockerfile?: string,
  ) => Promise<ImageRecord>;

  // a context the client uploaded, as a tar file; `signal` aborts when the
  // client goes, and ends the build
  readonly buildImageFromContext: (
    tarPath: string,
    name: string,
    dockerfile: string | undefined,
    signal: AbortSignal,
  ) => Promise<ImageRecord>;
  readonly listImages: () => Promise<ImageRecord[]>;
  readonly removeImage: (name: string) => Promise<void>;

  // the named image, else the configured default, else `ubuntu`
  readonly resolveImage: (name?: string) => Promise<ImageRecord>;

  // what resolveImage picks for a create that names no image, if anything
  readonly findDefaultImage: () => Promise<ImageRecord | undefined>;

  // adds ubuntu:24.04 as `ubuntu` when there are no images at all
  readonly seedDefaultImage: () => Promise<void>;
}

export interface ImageServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly storage: StorageBackend;

  // a build joins it until the image's row is written, a removal until its
  // rootfs is gone
  readonly storageGate: StorageGate;

  // a build holds room for the unpacked tree and its ext4 file
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;
}

function toBadRequest(error: unknown): unknown {
  return error instanceof DockerfileError
    ? new ORPCError('BAD_REQUEST', { message: `the Dockerfile: ${error.message}` })
    : error;
}

// the engine's platform, which a build without one runs for
async function readHostPlatform(signal: AbortSignal): Promise<string> {
  const version = await runCommand(
    ['docker', 'version', '--format', '{{json .Server.Os}} {{json .Server.Arch}}'],
    { signal },
  );

  signal.throwIfAborted();

  if (version.exitCode !== 0) {
    throw new Error(`docker version: ${version.stderr.trim()}`);
  }

  const [os, arch] = z.tuple([z.string(), z.string()]).parse(
    version.stdout
      .trim()
      .split(' ')
      .map((part): unknown => JSON.parse(part)),
  );

  return normalizePlatform(os, arch);
}

// what impd reads of an image the host has, or null when it lacks it
async function readPinInspect(ref: string, signal: AbortSignal): Promise<PinInspect | null> {
  const inspected = await runCommand(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, ref],
    { signal },
  );

  signal.throwIfAborted();

  if (inspected.exitCode !== 0) {
    return null;
  }

  return PinInspectSchema.parse(JSON.parse(inspected.stdout));
}

// the image the host has for ref, pulled first when it lacks it
async function loadImage(image: Readonly<ExternalImage>, signal: AbortSignal): Promise<PinInspect> {
  const ref = image.ref;

  const local = await readPinInspect(ref, signal);

  if (local !== null) {
    return local;
  }

  const pulled = await runCommand(['docker', 'pull', '--quiet', ref], { signal });

  signal.throwIfAborted();

  if (pulled.exitCode !== 0) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${image.use} ${ref}: the pull failed: ${pulled.stderr.trim().slice(-FAILURE_MAX_CHARS)}`,
    });
  }

  const loaded = await readPinInspect(ref, signal);

  if (loaded === null) {
    throw new Error(`docker image inspect ${ref} failed after its pull`);
  }

  return loaded;
}

// The pin for one image: its digest ref, once impd has checked the
// variant the host has, which is the one the build uses.
function pickPin(
  image: Readonly<ExternalImage>,
  inspect: Readonly<PinInspect>,
  platform: string,
): string {
  const ref = image.ref;
  const imagePlatform = formatPlatform(inspect.Os, inspect.Architecture);

  if (imagePlatform !== platform) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${image.use} ${ref}: the host has this image for ${imagePlatform}, and builds for ${platform}`,
    });
  }

  // the frontend runs the triggers of every image the build reaches, a
  // COPY --from or a mount's too, where impd cannot check them
  if ((inspect.OnBuild ?? []).length > 0) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${image.use} ${ref} has ONBUILD triggers, which impd refuses`,
    });
  }

  // a digest under a registry the pull rule refuses would reach it unpulled
  const repoDigests = inspect.RepoDigests ?? [];
  const allowed = repoDigests.filter((digest) => checkReferenceRegistry(digest) === null);
  const pin = pickRepoDigest(ref, allowed);

  if (pin === null && repoDigests.length > 0) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${image.use} ${ref}: its registry digests name only registries impd refuses: ${repoDigests.join(', ')}`,
    });
  }

  if (pin === null) {
    const advice = image.use === 'FROM' ? 'build FROM' : 'name';

    throw new ORPCError('BAD_REQUEST', {
      message: `${image.use} ${ref}: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; ${advice} a registry image by tag or digest. Local base images are not supported yet (#156).`,
    });
  }

  return pin;
}

export function createImageService(deps: ImageServiceDeps): ImageService {
  const storageGate = deps.storageGate;

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

  // OCI image → sparse ext4
  // (docs/architecture/storage.md#images-any-oci-image); returns the rootfs
  // size on disk
  const buildRootfs = async (ref: string, digest: string, ociConfig: unknown): Promise<number> => {
    const paths = buildImagePaths(deps.config.dataDir, digest);

    if (existsSync(paths.rootfs)) {
      return readDiskUsage(paths.rootfs);
    }

    const images = join(deps.config.dataDir, 'images');
    const work = join(images, `.build-${Bun.randomUUIDv7()}`);
    const root = join(work, 'root');

    // 0700: a host user must not reach the tree, whose setuid and capability
    // files are live while it is unpacked
    mkdirSync(images, { recursive: true });
    mkdirSync(work, { mode: 0o700 });
    mkdirSync(root, { mode: 0o755 });

    const created = await runChecked(['docker', 'create', ref, '/bin/true']);

    const containerId = created.trim();

    try {
      await writeExportedTree(containerId, root);

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

    const taken = await findImageByName(deps.db, imageName);

    requireDockerImage(taken);

    const inspect = await readInspect(ref);

    if (inspect === undefined) {
      throw new Error(`docker image inspect ${ref}: no result`);
    }

    // the tree unpacked, and the ext4 file written from it
    const buildBytes = 2 * (inspect.Size ?? 0);
    const withRoom = deps.diskBudget.withRoom;

    return withRoom(buildBytes, () =>
      storageGate.join(async () => {
        const sizeBytes = await buildRootfsOnce(ref, inspect.Id, inspect.Config);
        const existing = await findImageByName(deps.db, imageName);

        requireDockerImage(existing);

        if (existing === undefined) {
          return createImage(deps.db, {
            name: imageName,
            ref,
            digest: inspect.Id,
            sizeBytes,
          });
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
      }),
    );
  };

  const findDefaultImage = async (): Promise<ImageRecord | undefined> => {
    for (const name of [deps.config.defaultImage, FALLBACK_DEFAULT_IMAGE]) {
      const image = await findImageByName(deps.db, name);

      if (image !== undefined) {
        return image;
      }
    }

    return undefined;
  };

  // A sessionless build cannot ask impd for registry credentials: each image
  // the Dockerfile names and the host lacks is pulled first, as `imp image
  // add` does. Returns the Dockerfile with each image pinned to its digest.
  const resolvePinnedDockerfile = async (dockerfile: string, signal: AbortSignal) => {
    const images = (() => {
      try {
        return checkDockerfile(dockerfile);
      } catch (error) {
        throw toBadRequest(error);
      }
    })();

    const platform = await readHostPlatform(signal);

    const pins = new Map<string, string>();

    const used: Pin[] = [];

    const stores = new Set<ImageStore>();

    // each ref inspected and pinned once, whatever its uses: a tag that
    // moves between two inspects would give the build two images
    const distinct = images.filter(
      (candidate, index) => images.findIndex((other) => other.ref === candidate.ref) === index,
    );

    for (const image of distinct) {
      if (!ImageRefSchema.safeParse(image.ref).success) {
        throw new ORPCError('BAD_REQUEST', {
          message: `${image.use} ${JSON.stringify(image.ref)} is not an image reference`,
        });
      }

      // the host may have it already, and then no pull meets the proxy
      const registryProblem = checkReferenceRegistry(image.ref);

      if (registryProblem !== null) {
        throw new ORPCError('BAD_REQUEST', {
          message: `${image.use} ${image.ref}: ${registryProblem}`,
        });
      }

      signal.throwIfAborted();

      const inspect = await loadImage(image, signal);

      const pin = pickPin(image, inspect, platform);

      pins.set(image.ref, pin);
      stores.add(readImageStore(inspect));
    }

    for (const image of images) {
      used.push({ use: image.use, ref: image.ref, pin: pins.get(image.ref) ?? '' });
    }

    const store = [...stores].find((candidate) => candidate !== 'unknown') ?? 'unknown';

    try {
      return { dockerfile: renderPinnedDockerfile(dockerfile, pins, platform), pins: used, store };
    } catch (error) {
      throw toBadRequest(error);
    }
  };

  // nothing from the client reaches the engine but the tag's name and the
  // Dockerfile's path in the context, both validated by the API schemas
  // and again by imp-docker-proxy
  const buildFromContext = async (
    tarPath: string,
    name: string,
    givenDockerfile: string | undefined,
    signal: AbortSignal,
  ): Promise<ImageRecord> => {
    const tag = `imp/${NameSchema.parse(name)}:latest`;
    const tarBytes = statSync(tarPath).size;
    const dockerfilePath = normalizeDockerfilePath(givenDockerfile);
    const rewrittenPath = `${tarPath}.rewritten`;

    // the pins the build used, for a failure the engine reports
    let pins: readonly Pin[] = [];

    try {
      // the rewrite is the context again, with pax headers for long names
      await deps.diskBudget.withRoom(tarBytes, async () => {
        const context = await readBuildContext(tarPath, dockerfilePath, DOCKERFILE_MAX_BYTES).catch(
          (error: unknown) => {
            throw error instanceof BuildContextError
              ? new ORPCError('BAD_REQUEST', { message: error.message })
              : error;
          },
        );

        const pinned = await resolvePinnedDockerfile(context.dockerfile, signal);

        pins = pinned.pins;

        console.log(
          `impd: image build ${name}: ${String(pinned.pins.length)} images pinned, image store ${pinned.store}`,
        );

        signal.throwIfAborted();

        await writeBuildContext(
          tarPath,
          rewrittenPath,
          context,
          pinned.dockerfile,
          DOCKERFILE_MAX_BYTES,
        );

        signal.throwIfAborted();

        // the engine keeps its own copy of the context while it builds
        await deps.diskBudget.withRoom(statSync(rewrittenPath).size, () =>
          runDockerBuild({
            dockerHost: deps.config.dockerHost,
            tarPath: rewrittenPath,
            tag,
            dockerfile: context.dockerfilePath,
            signal,
          }),
        );
      });
    } catch (error) {
      // nobody waits for the image: the build was stopped, or its tag is left
      signal.throwIfAborted();

      if (error instanceof DockerBuildError) {
        throw new ORPCError('BAD_REQUEST', { message: formatPinFailure(error.message, pins) });
      }

      throw error;
    } finally {
      rmSync(rewrittenPath, { force: true });
    }

    signal.throwIfAborted();

    return createImageFromRef(tag, name);
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

      // packed here as the CLI packs an upload: the engine does not read
      // .dockerignore from a context sent as the body
      const entries = await listContextEntries(
        contextDir,
        normalizeDockerfilePath(dockerfile),
      ).catch((error: unknown) => {
        throw error instanceof MissingDockerfileError
          ? new ORPCError('BAD_REQUEST', { message: error.message })
          : error;
      });

      const tarBytes = await countTarBytes(entries);

      const maxBytes = deps.config.buildContextMaxBytes;

      // the limit an upload has, and the proxy's
      if (tarBytes > maxBytes) {
        throw new ORPCError('BAD_REQUEST', {
          message: `the build context is ${String(tarBytes)} bytes, over the limit of ${String(Math.floor(maxBytes / 1024 ** 2))} MiB (IMP_BUILD_CONTEXT_MAX_MIB)`,
        });
      }

      const uploadsDir = buildUploadsDir(deps.config.dataDir);
      const tarPath = join(uploadsDir, `${Bun.randomUUIDv7()}.tar`);

      mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

      return deps.diskBudget.withRoom(tarBytes, async () => {
        try {
          await writeContextTar(entries, tarPath);

          // nobody to abort it: the oRPC call waits for the image
          return await buildFromContext(tarPath, name, dockerfile, new AbortController().signal);
        } finally {
          rmSync(tarPath, { force: true });
        }
      });
    },
    buildImageFromContext: buildFromContext,
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
    findDefaultImage,
    seedDefaultImage: async () => {
      const images = await listImages(deps.db);

      if (images.length === 0) {
        await createImageFromRef(SEED_REF, FALLBACK_DEFAULT_IMAGE);
      }
    },
  };
}

// The Dockerfile's path in the context in one spelling, `./a//Dockerfile`
// as `a/Dockerfile`, which the proxy checks; one that leaves the context is
// refused.
export function normalizeDockerfilePath(path: string | undefined): string {
  const normalized = posix.normalize(path ?? 'Dockerfile');

  if (
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized === '.' ||
    normalized.endsWith('/')
  ) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the Dockerfile path ${JSON.stringify(path)} is not a file inside the build context`,
    });
  }

  return normalized;
}

// A template is never rebuilt from docker: its name is made again from an
// imp (docs/guides/templates.md)
function requireDockerImage(existing: ImageRecord | undefined): void {
  if (existing?.source === 'imp') {
    throw buildConflictError(
      'image',
      existing.name,
      `image ${existing.name} is a template; make it again from an imp, or pick another name`,
    );
  }
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
