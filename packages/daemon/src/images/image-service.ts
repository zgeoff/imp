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
import { checkReferenceRegistry, readImageReference } from '../docker-proxy/rules';
import { runChecked, runCommand } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import { buildImagePaths, buildUploadsDir } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import type { StorageBackend } from '../storage/storage-backend';
import type { StorageGate } from '../storage/storage-gate';
import { createBuildEngine } from './build-engine';
import type { BuildEngine, EngineRun } from './build-engine';
import { BUILDER_IMAGE } from './builder-imps';
import type { Builders } from './builder-imps';
import { DockerBuildError, runDockerBuild } from './docker-build';
import { checkDockerfile, renderPinnedDockerfile } from './dockerfile-check';
import type { ExternalImage } from './dockerfile-check';
import { DockerfileError } from './dockerfile-error';
import { loadGuestImage, runGuestBuild, writeGuestTree } from './guest-build';
import type { GuestExec } from './guest-exec';
import { buildImageRuntimeConfig, deriveImageName } from './image-naming';
import { formatPinFailure, formatPlatform, pickRepoDigest, readImageStore } from './image-pin';
import type { ImageStore, Pin, PinInspect } from './image-pin';
import { writeExportedTree } from './unpack-export';
import { writeContextTar } from './write-context-tar';
import { writeImageConfig } from './write-image-config';

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
const SEED_REF = 'ubuntu:24.04';

export const HOST_BUILD_WARNING =
  'impd: WARNING: IMP_BUILD_ISOLATION=host: image builds run on the host engine, whose RUN steps can reach the host and its private networks; for a trusted operator only, and gone in the next release (docs/guides/images.md#isolated-builds)';

export const HOST_ADD_WARNING =
  'impd: WARNING: IMP_BUILD_ISOLATION=host: image adds pull onto the host engine, which keeps each image impd pulled; gone in the next release (docs/guides/images.md#add-an-image)';

const RepoDigestsSchema = z.array(z.string()).nullish();

const InspectSchema = z
  .array(
    z.object({
      Id: z.string(),
      Config: z.unknown(),
      Size: z.number().optional(),
      RepoDigests: RepoDigestsSchema,
    }),
  )
  .length(1);

interface AddImageOptions {
  // a client that goes ends the pull, and the builder with it
  readonly signal?: AbortSignal | undefined;

  // the reference the pull resolved, by digest, once it is known
  readonly onResolved?: (reference: string) => void;
}

// an add's options once its signal is settled
interface AddFromRefOptions extends AddImageOptions {
  readonly signal: AbortSignal;
}

export interface ImageService {
  // `signal` aborts when the client goes, and ends the add and its builder
  readonly addImage: (
    ref: string,
    name?: string,
    options?: Readonly<AddImageOptions>,
  ) => Promise<ImageRecord>;
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

  // adds IMP_BUILD_IMAGE as the builders' image, unless it is that already
  // a caller that goes stops waiting; the pull goes on for the others
  readonly ensureBuilderImage: (signal?: AbortSignal) => Promise<void>;
}

// the host's engine, through imp-docker-proxy
function runOnHost(argv: readonly string[], signal: AbortSignal): ReturnType<EngineRun> {
  return runCommand(argv, { signal });
}

// a builder's engine, through its agent
function toEngineRun(exec: GuestExec): EngineRun {
  return (argv, signal) => exec(argv, { signal });
}

// a name a client may give an image: BUILDER_IMAGE is impd's
function requireClientImageName(name: string): string {
  const imageName = NameSchema.parse(name);

  if (imageName === BUILDER_IMAGE) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the image name ${BUILDER_IMAGE} is impd's, for its image builders; pick another`,
    });
  }

  return imageName;
}

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

  // BUILDER_IMAGE_PULL_MS, but for tests
  readonly builderImagePullMs?: number;
}

// how long the builder image's pull onto the host engine may take; a hung
// pull would hold every add and build
const BUILDER_IMAGE_PULL_MS = 600_000;

interface HostImageOptions {
  readonly onResolved?: ((reference: string) => void) | undefined;

  // kills the inspect and the pull when it aborts
  readonly signal?: AbortSignal | undefined;
}

// `pulling`, or the abort of the caller's signal, whichever comes first
async function waitForPull(pulling: Promise<unknown>, signal: AbortSignal | undefined) {
  if (signal === undefined) {
    await pulling;

    return;
  }

  signal.throwIfAborted();

  const aborted = Promise.withResolvers<never>();

  const stopWaiting = () => {
    aborted.reject(signal.reason);
  };

  signal.addEventListener('abort', stopWaiting, { once: true });

  try {
    await Promise.race([pulling, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', stopWaiting);
  }
}

function toBadRequest(error: unknown): unknown {
  return error instanceof DockerfileError
    ? new ORPCError('BAD_REQUEST', { message: `the Dockerfile: ${error.message}` })
    : error;
}

// The reference with the tag the engine would assume written out, so the
// pull, the log and the error name what is fetched: `ubuntu` is
// `ubuntu:latest`
function formatExplicitRef(ref: string): string {
  const [withoutDigest = ''] = ref.split('@');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const hasTag = withoutDigest.includes(':', lastSlash + 1);

  return ref.includes('@') || hasTag ? ref : `${ref}:latest`;
}

// one image's every spelling: the engine's registry and path, and the tag
// (latest when none) and digest
function toImageKey(ref: string): string {
  const named = readImageReference(ref);
  const [withoutDigest = '', digest = ''] = ref.split('@');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const tagColon = withoutDigest.indexOf(':', lastSlash + 1);
  const tag = tagColon === -1 ? 'latest' : withoutDigest.slice(tagColon + 1);

  return `${named.registry}/${named.path}:${tag}@${digest}`;
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

  const readInspect = async (ref: string, signal?: AbortSignal) => {
    const options = signal === undefined ? {} : { signal };

    const first = await runCommand(['docker', 'image', 'inspect', ref], options);

    if (first.exitCode === 0) {
      return InspectSchema.parse(JSON.parse(first.stdout))[0];
    }

    await runChecked(['docker', 'pull', '--quiet', ref], options);

    const stdout = await runChecked(['docker', 'image', 'inspect', ref], options);

    return InspectSchema.parse(JSON.parse(stdout))[0];
  };

  // A fresh directory for an unpacked tree. 0700: a host user must not
  // reach the tree, whose setuid and capability files are live while it is
  // unpacked.
  const makeWorkDir = (): { work: string; root: string } => {
    const images = join(deps.config.dataDir, 'images');
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

    const workDir = makeWorkDir();
    const root = workDir.root;

    const created = await runChecked(['docker', 'create', ref, '/bin/true']);

    const containerId = created.trim();

    try {
      await writeExportedTree(containerId, root);

      return await writeRootfs(root, digest, ociConfig);
    } finally {
      await runCommand(['docker', 'rm', '-f', containerId]);

      rmSync(workDir.work, { recursive: true, force: true });
    }
  };

  // one rootfs per digest at a time; a second build of it waits for the first
  const createRootfsOnce = async (digest: string, create: () => Promise<number>) => {
    const inFlight = building.get(digest);

    if (inFlight !== undefined) {
      return inFlight;
    }

    const promise = create();

    building.set(digest, promise);

    try {
      return await promise;
    } finally {
      building.delete(digest);
    }
  };

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

    await removeUnusedRootfs(existing.digest);

    return updated;
  };

  // drops an image directory no image row points at any more
  const removeUnusedRootfs = async (digest: string): Promise<void> => {
    const uses = await countImageDigestUses(deps.db, digest);

    if (uses === 0) {
      await deps.storage.removeImage(digest);
    }
  };

  // An image of the host's engine, pulled there when it lacks it: the
  // builders' own image, and every add and build under
  // IMP_BUILD_ISOLATION=host
  const createImageOnHost = async (
    ref: string,
    imageName: string,
    options: Readonly<HostImageOptions> = {},
  ): Promise<ImageRecord> => {
    const onResolved = options.onResolved;

    const inspect = await readInspect(ref, options.signal);

    if (inspect === undefined) {
      throw new Error(`docker image inspect ${ref}: no result`);
    }

    const resolved = pickRepoDigest(ref, inspect.RepoDigests ?? []);

    if (resolved !== null) {
      onResolved?.(resolved);
    }

    // the tree unpacked, and the ext4 file written from it
    const buildBytes = 2 * (inspect.Size ?? 0);
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

  // An image pulled in a builder imp and streamed out of it, as a build's
  // result is (docs/guides/images.md#add-an-image); the host engine never
  // has it. A refused builder fails the add: it never falls back.
  const createImageInBuilder = (
    ref: string,
    imageName: string,
    options: Readonly<AddFromRefOptions>,
  ): Promise<ImageRecord> => {
    const signal = options.signal;
    const builders = deps.readBuilders();

    if (builders === null) {
      throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'impd is starting; try again' });
    }

    const explicitRef = formatExplicitRef(ref);

    return builders.withBuilder(signal, async (exec) => {
      const started = performance.now();

      const platform = await createBuildEngine(toEngineRun(exec)).readPlatform(signal);
      const pulled = await loadGuestImage(exec, { ref: explicitRef, platform, signal });

      if (pulled !== null) {
        options.onResolved?.(pulled);
      }

      const pullMs = Math.round(performance.now() - started);

      const image = await writeGuestImage(exec, imageName, ref, signal);

      const imageMs = Math.round(performance.now() - started) - pullMs;

      deps.log(
        `impd: image add ${imageName}: ${explicitRef} for ${platform}${pulled === null ? '' : ` (${pulled})`}, digest ${image.digest}; pull=${String(pullMs)}ms image=${String(imageMs)}ms`,
      );

      return image;
    });
  };

  // `isImpds`: impd's own add, of a name no client may take
  const createImageFromRef = async (
    ref: string,
    name: string | undefined,
    isImpds: boolean,
    options: Readonly<AddFromRefOptions>,
  ): Promise<ImageRecord> => {
    assertImageRef(ref);

    // the proxy holds this rule for a host pull; a builder's pull would
    // reach a literal address under imp isolation, so impd holds it for both
    const registryProblem = checkReferenceRegistry(ref);

    if (registryProblem !== null) {
      throw new ORPCError('BAD_REQUEST', { message: `image ${ref}: ${registryProblem}` });
    }

    const givenName = name ?? deriveImageName(ref);
    const imageName = isImpds ? NameSchema.parse(givenName) : requireClientImageName(givenName);

    const taken = await findImageByName(deps.db, imageName);

    requireDockerImage(taken);

    if (deps.config.build.isolation === 'host') {
      deps.log(HOST_ADD_WARNING);

      return createImageOnHost(ref, imageName, { onResolved: options.onResolved });
    }

    return createImageInBuilder(ref, imageName, options);
  };

  // the builders' image, at most one add of it at a time
  const builderImage = { adding: null as Promise<ImageRecord> | null };

  // The one add of the builder image, under its own timeout and no caller's
  // signal; once it settles, the next add starts afresh
  const startBuilderImage = (ref: string): Promise<ImageRecord> => {
    const pullMs = deps.builderImagePullMs ?? BUILDER_IMAGE_PULL_MS;
    const timeout = AbortSignal.timeout(pullMs);

    const createBuilderImage = async (): Promise<ImageRecord> => {
      try {
        return await createImageOnHost(ref, BUILDER_IMAGE, { signal: timeout });
      } catch (error) {
        const reason = timeout.aborted
          ? `the pull did not finish in ${String(pullMs / 1000)} s`
          : readErrorMessage(error);

        throw new ORPCError('SERVICE_UNAVAILABLE', {
          message: `impd cannot add its builder image ${ref} (IMP_BUILD_IMAGE) from the host engine, so no image add or build can run: ${reason}`,
        });
      }
    };

    const adding = createBuilderImage();

    const removeOnSettle = async () => {
      try {
        await adding;
      } catch {
        // each caller gets the error from its own wait
      } finally {
        if (builderImage.adding === adding) {
          builderImage.adding = null;
        }
      }
    };

    builderImage.adding = adding;
    void removeOnSettle();

    return adding;
  };

  const loadBuilderImage = async (signal?: AbortSignal): Promise<void> => {
    const ref = deps.config.build.image;

    const image = await findImageByName(deps.db, BUILDER_IMAGE);

    if (image?.ref === ref) {
      return;
    }

    await waitForPull(builderImage.adding ?? startBuilderImage(ref), signal);
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

  // Each image the Dockerfile names and the engine lacks is pulled first,
  // on the engine that builds. Returns the Dockerfile with each image pinned
  // to its digest.
  const resolvePinnedDockerfile = async (
    dockerfile: string,
    images: readonly ExternalImage[],
    engine: BuildEngine,
    signal: AbortSignal,
  ) => {
    const platform = await engine.readPlatform(signal);

    const pins = new Map<string, string>();

    const used: Pin[] = [];

    const stores = new Set<ImageStore>();

    // Each image inspected and pinned once, whatever its uses or spellings
    // (`busybox` is `docker.io/library/busybox:latest`): a tag that moves
    // between two inspects would give the build two images.
    const keys = new Map<string, string>();

    for (const image of images) {
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

      const key = toImageKey(image.ref);
      const known = keys.get(key);

      if (known === undefined) {
        signal.throwIfAborted();

        const inspect = await engine.loadImage(image, signal);

        keys.set(key, pickPin(image, inspect, platform));
        stores.add(readImageStore(inspect));
      }

      pins.set(image.ref, keys.get(key) ?? '');
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

  // The host build (IMP_BUILD_ISOLATION=host): the tag's name and the
  // Dockerfile's path are all of the client's that reach the engine, checked
  // again by imp-docker-proxy. Its RUN steps reach what the engine reaches.
  const runHostBuild = (tarPath: string, tag: string, dockerfile: string, signal: AbortSignal) =>
    deps.diskBudget.withRoom(statSync(tarPath).size, () =>
      runDockerBuild({ dockerHost: deps.config.dockerHost, tarPath, tag, dockerfile, signal }),
    );

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

          const digest = exported.digest;
          const rootfs = buildImagePaths(deps.config.dataDir, digest).rootfs;

          const sizeBytes = await createRootfsOnce(digest, () =>
            existsSync(rootfs)
              ? Promise.resolve(readDiskUsage(rootfs))
              : writeRootfs(root, digest, exported.config),
          );

          return await writeImageRow(imageName, ref, digest, sizeBytes);
        } finally {
          rmSync(workDir.work, { recursive: true, force: true });
        }
      }),
    );
  };

  const buildFromContext = async (
    tarPath: string,
    name: string,
    givenDockerfile: string | undefined,
    signal: AbortSignal,
  ): Promise<ImageRecord> => {
    const imageName = requireClientImageName(name);
    const tag = `imp/${imageName}:latest`;
    const tarBytes = statSync(tarPath).size;
    const dockerfilePath = normalizeDockerfilePath(givenDockerfile);
    const rewrittenPath = `${tarPath}.rewritten`;
    const isolation = deps.config.build.isolation;

    // the pins the build used, for a failure the engine reports
    let pins: readonly Pin[] = [];

    try {
      // the rewrite is the context again, with pax headers for long names
      const built = await deps.diskBudget.withRoom(tarBytes, async () => {
        const context = await readBuildContext(
          tarPath,
          dockerfilePath,
          DOCKERFILE_MAX_BYTES,
          signal,
        ).catch((error: unknown) => {
          throw error instanceof BuildContextError
            ? new ORPCError('BAD_REQUEST', { message: error.message })
            : error;
        });

        const dockerfile = context.dockerfilePath ?? 'Dockerfile';

        // the input guard (#145): a Dockerfile it refuses boots no builder
        const named = (() => {
          try {
            return checkDockerfile(context.dockerfile);
          } catch (error) {
            throw toBadRequest(error);
          }
        })();

        // the pins, on the engine that builds
        const writePinnedContext = async (engine: BuildEngine): Promise<void> => {
          const pinned = await resolvePinnedDockerfile(context.dockerfile, named, engine, signal);

          pins = pinned.pins;

          const pinList = pinned.pins.map((pin) => `${pin.use} ${pin.ref} as ${pin.pin}`);

          deps.log(
            `impd: image build ${name} (${isolation}): image store ${pinned.store}; pinned ${pinList.join(', ') || 'no image'}`,
          );

          signal.throwIfAborted();

          await writeBuildContext(
            tarPath,
            rewrittenPath,
            context,
            pinned.dockerfile,
            DOCKERFILE_MAX_BYTES,
            signal,
          );

          signal.throwIfAborted();

          // a prune between this and the build fails it with the engine's
          // error, and the client can retry
          await engine.loadFrontend(signal);
        };

        if (isolation === 'host') {
          deps.log(HOST_BUILD_WARNING);

          await writePinnedContext(createBuildEngine(runOnHost));
          await runHostBuild(rewrittenPath, tag, dockerfile, signal);

          return null;
        }

        const builders = deps.readBuilders();

        if (builders === null) {
          throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'impd is starting; try again' });
        }

        return builders.withBuilder(signal, async (exec) => {
          const started = performance.now();

          await writePinnedContext(createBuildEngine(toEngineRun(exec)));

          const pinned = performance.now();

          await runGuestBuild(exec, { tarPath: rewrittenPath, dockerfile, signal });

          const ran = performance.now();

          const image = await writeGuestImage(exec, imageName, tag, signal);

          const pinsMs = Math.round(pinned - started);
          const buildMs = Math.round(ran - pinned);
          const imageMs = Math.round(performance.now() - ran);

          // pins: the pulls, cold in each builder; image: the export and its rootfs
          deps.log(
            `impd: image build ${name} (imp): pins=${String(pinsMs)}ms build=${String(buildMs)}ms image=${String(imageMs)}ms`,
          );

          return image;
        });
      });

      signal.throwIfAborted();

      if (built !== null) {
        return built;
      }

      return await createImageOnHost(tag, NameSchema.parse(name));
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
    addImage: (ref, name, options) =>
      createImageFromRef(ref, name, false, {
        ...options,
        signal: options?.signal ?? new AbortController().signal,
      }),
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
    ensureBuilderImage: loadBuilderImage,
    seedDefaultImage: async () => {
      const images = await listImages(deps.db);

      if (images.length === 0) {
        await createImageFromRef(SEED_REF, FALLBACK_DEFAULT_IMAGE, true, {
          signal: new AbortController().signal,
        });
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
