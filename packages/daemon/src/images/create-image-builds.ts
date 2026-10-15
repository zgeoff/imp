import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { ImageRefSchema, NameSchema } from '@impz/api';
import type { ImageBuildPhase } from '@impz/api';
import {
  BuildContextError,
  MissingDockerfileError,
  countTarBytes,
  listContextEntries,
  readBuildContext,
  writeBuildContext,
} from '@impz/local-tar';
import { ORPCError } from '@orpc/server';
import type { Config } from '../config';
import type { ImageRecord } from '../db/images';
import { checkReferenceRegistry, readImageReference } from '../docker-proxy/rules';
import { runCommand } from '../process/run-command';
import { buildUploadsDir } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import { createBuildEngine, toEngineRun } from './build-engine';
import type { BuildEngine, EngineRun } from './build-engine';
import { createBuildSlots } from './build-slots';
import type { Builders } from './builder-imps';
import { createBuildRuns } from './create-build-runs';
import type { BuildRuns } from './create-build-runs';
import type { BuildOutput } from './create-build-steps';
import { requireClientImageName } from './create-image-writer';
import type { ImageWriter } from './create-image-writer';
import { DockerBuildError, runDockerBuild } from './docker-build';
import { checkDockerfile, renderPinnedDockerfile } from './dockerfile-check';
import type { ExternalImage } from './dockerfile-check';
import { DockerfileError } from './dockerfile-error';
import { runGuestBuild } from './guest-build';
import { formatPinFailure, formatPlatform, pickRepoDigest, readImageStore } from './image-pin';
import type { ImageStore, Pin, PinInspect } from './image-pin';
import { runDocker } from './run-docker';
import { writeContextTar } from './write-context-tar';

// the largest Dockerfile impd reads for its FROM lines
const DOCKERFILE_MAX_BYTES = 1024 ** 2;

export const HOST_BUILD_WARNING =
  'impd: WARNING: IMP_BUILD_ISOLATION=host: image builds run on the host engine, whose RUN steps can reach the host and its private networks; for a trusted operator only, and gone in the next release (docs/guides/images.md#isolated-builds)';

// what a streamed add or build hears of: `signal` aborts when the client
// goes, `setPhase` hears each phase as it starts, `output` a build's lines
// and steps, and `setBuilder` the builder imp an isolated build runs in
interface ImageOpOptions {
  readonly signal?: AbortSignal;
  readonly setPhase?: (phase: ImageBuildPhase) => void;
  readonly output?: BuildOutput | undefined;
  readonly setBuilder?: (name: string) => void;
}

export interface ImageBuilds {
  readonly buildImage: (
    contextDir: string,
    name: string,
    dockerfile?: string,
    options?: Readonly<ImageOpOptions>,
  ) => Promise<ImageRecord>;

  // a context the client uploaded, as a tar file; `signal` aborts when the
  // client goes, and ends the build
  readonly buildImageFromContext: (
    tarPath: string,
    name: string,
    dockerfile: string | undefined,
    options: Readonly<ImageOpOptions> & { readonly signal: AbortSignal },
  ) => Promise<ImageRecord>;

  // one of the build slots an upload and an on-host build share;
  // TOO_MANY_REQUESTS when all are taken
  readonly claimBuildSlot: () => () => void;

  // an upload's entry in images.builds; buildImage makes its own
  readonly startBuildRun: BuildRuns['start'];
  readonly listBuildRuns: BuildRuns['list'];
}

interface ImageBuildsDeps {
  readonly config: Config;

  // a build holds room for its context and the rewrite of it
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;

  // where an isolated build runs; null until the imps are up
  readonly readBuilders: () => Builders | null;
  readonly log: (message: string) => void;

  // the start time of each build images.builds lists; Date.now by default
  readonly now?: () => number;
}

// images.build: a Dockerfile's images pinned and the build run in a builder
// imp, or on the host engine under IMP_BUILD_ISOLATION=host
export function createImageBuilds(deps: ImageBuildsDeps, writer: ImageWriter): ImageBuilds {
  const buildRuns = createBuildRuns(deps.now ?? Date.now);
  const buildSlots = createBuildSlots();

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
  const runHostBuild = (
    tarPath: string,
    tag: string,
    dockerfile: string,
    signal: AbortSignal,
    output: BuildOutput | undefined,
  ) =>
    deps.diskBudget.withRoom(statSync(tarPath).size, () =>
      runDockerBuild({
        dockerHost: deps.config.dockerHost,
        tarPath,
        tag,
        dockerfile,
        signal,
        output,
      }),
    );

  const buildFromContext = async (
    tarPath: string,
    name: string,
    givenDockerfile: string | undefined,
    options: Readonly<ImageOpOptions> & { readonly signal: AbortSignal },
  ): Promise<ImageRecord> => {
    const signal = options.signal;
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
          await runHostBuild(rewrittenPath, tag, dockerfile, signal, options.output);

          return null;
        }

        const builders = deps.readBuilders();

        if (builders === null) {
          throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'impd is starting; try again' });
        }

        return builders.withBuilder(signal, async (exec, builderName) => {
          options.setBuilder?.(builderName);
          const started = performance.now();

          await writePinnedContext(createBuildEngine(toEngineRun(exec)));

          const pinned = performance.now();

          await runGuestBuild(exec, {
            tarPath: rewrittenPath,
            dockerfile,
            signal,
            output: options.output,
          });

          const ran = performance.now();

          // the export out of the builder, and its unpack
          options.setPhase?.('unpack');

          const image = await writer.writeGuestImage(exec, imageName, tag, signal);

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

      // the tag is the engine's now: no pull, only the unpack
      return await writer.createImageOnHost(tag, NameSchema.parse(name), {
        ...(options.setPhase !== undefined && { setPhase: options.setPhase }),
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
  };

  // packed on the impd host, as the CLI packs an upload; holds a build slot
  // from the first check to the image
  const buildOnHost = async (
    contextDir: string,
    name: string,
    dockerfile: string | undefined,
    options: Readonly<ImageOpOptions>,
  ): Promise<ImageRecord> => {
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
        message: `build context ${contextDir} does not exist on the impd host; build the image there and use \`impz image add\``,
      });
    }

    // packed here as the CLI packs an upload: the engine does not read
    // .dockerignore from a context sent as the body
    const entries = await listContextEntries(contextDir, normalizeDockerfilePath(dockerfile)).catch(
      (error: unknown) => {
        throw error instanceof MissingDockerfileError
          ? new ORPCError('BAD_REQUEST', { message: error.message })
          : error;
      },
    );

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

        options.setPhase?.('build');

        // images.build has no signal: its call waits for the image
        return await buildFromContext(tarPath, name, dockerfile, {
          ...options,
          signal: options.signal ?? new AbortController().signal,
        });
      } finally {
        rmSync(tarPath, { force: true });
      }
    });
  };

  return {
    buildImage: async (contextDir, name, dockerfile, options = {}) => {
      const release = buildSlots.claim();
      const run = buildRuns.start(name, 'host');

      try {
        return await buildOnHost(contextDir, name, dockerfile, {
          ...options,
          setPhase: (phase) => {
            run.setPhase(phase);
            options.setPhase?.(phase);
          },
          output: {
            emitLog: (line) => {
              options.output?.emitLog(line);
            },
            setStep: (step) => {
              run.setStep(step);
              options.output?.setStep(step);
            },
          },
          setBuilder: (builder) => {
            run.setBuilder(builder);
            options.setBuilder?.(builder);
          },
        });
      } finally {
        run.end();

        release();
      }
    },
    buildImageFromContext: buildFromContext,
    claimBuildSlot: buildSlots.claim,
    startBuildRun: buildRuns.start,
    listBuildRuns: buildRuns.list,
  };
}

// the host's engine, through imp-docker-proxy
function runOnHost(argv: readonly string[], signal: AbortSignal): ReturnType<EngineRun> {
  const [command, ...args] = argv;

  return command === 'docker' ? runDocker(args, { signal }) : runCommand(argv, { signal });
}

function toBadRequest(error: unknown): unknown {
  return error instanceof DockerfileError
    ? new ORPCError('BAD_REQUEST', { message: `the Dockerfile: ${error.message}` })
    : error;
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
