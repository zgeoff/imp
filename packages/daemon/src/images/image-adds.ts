import { ImageRefSchema, NameSchema } from '@imp/api';
import type { ImageBuildPhase } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { Config } from '../config';
import { findImageByName, listImages } from '../db/images';
import type { ImageRecord } from '../db/images';
import type { ImpDatabase } from '../db/open-database';
import { checkReferenceRegistry } from '../docker-proxy/rules';
import { createSingleFlight } from '../process/single-flight';
import { readErrorMessage } from '../read-error-message';
import { createBuildEngine, toEngineRun } from './build-engine';
import { BUILDER_IMAGE } from './builder-imps';
import type { Builders } from './builder-imps';
import { loadGuestImage } from './guest-build';
import { deriveImageName } from './image-naming';
import { requireClientImageName, requireDockerImage } from './image-writer';
import type { ImageWriter } from './image-writer';

export const FALLBACK_DEFAULT_IMAGE = 'ubuntu';
const SEED_REF = 'ubuntu:24.04';

export const HOST_ADD_WARNING =
  'impd: WARNING: IMP_BUILD_ISOLATION=host: image adds pull onto the host engine, which keeps each image impd pulled; gone in the next release (docs/guides/images.md#add-an-image)';

interface AddImageOptions {
  readonly setPhase?: (phase: ImageBuildPhase) => void;

  // a client that goes ends the pull, and the builder with it
  readonly signal?: AbortSignal | undefined;

  // the reference the pull resolved, by digest, once it is known
  readonly onResolved?: (reference: string) => void;
}

// an add's options once its signal is settled
interface AddFromRefOptions extends AddImageOptions {
  readonly signal: AbortSignal;
}

export interface ImageAdds {
  // `signal` aborts when the client goes, and ends the add and its builder
  readonly addImage: (
    ref: string,
    name?: string,
    options?: Readonly<AddImageOptions>,
  ) => Promise<ImageRecord>;

  // adds ubuntu:24.04 as `ubuntu` when there are no images at all
  readonly seedDefaultImage: () => Promise<void>;

  // adds IMP_BUILD_IMAGE as the builders' image, unless it is that already
  // a caller that goes stops waiting; the pull goes on for the others
  readonly ensureBuilderImage: (signal?: AbortSignal) => Promise<void>;
}

interface ImageAddsDeps {
  readonly config: Config;
  readonly db: ImpDatabase;

  // where an isolated add runs; null until the imps are up
  readonly readBuilders: () => Builders | null;
  readonly log: (message: string) => void;

  // BUILDER_IMAGE_PULL_MS, but for tests; undefined keeps the default
  readonly builderImagePullMs?: number | undefined;

  // starts the limit on the builder image's pull; AbortSignal.timeout by
  // default, and a signal the test aborts in tests
  readonly startPullLimit?: (pullMs: number) => AbortSignal;
}

// how long the builder image's pull onto the host engine may take; a hung
// pull would hold every add and build
const BUILDER_IMAGE_PULL_MS = 600_000;

// images.add: an image pulled in a builder imp, or on the host engine under
// IMP_BUILD_ISOLATION=host, and impd's own adds of the builder image and
// the default image
export function createImageAdds(deps: ImageAddsDeps, writer: ImageWriter): ImageAdds {
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

      // the export out of the builder, and its unpack
      options.setPhase?.('unpack');

      const image = await writer.writeGuestImage(exec, imageName, ref, signal);

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

      return writer.createImageOnHost(ref, imageName, options);
    }

    return createImageInBuilder(ref, imageName, options);
  };

  // the builders' image, at most one add of it at a time
  const builderImage = createSingleFlight<ImageRecord>();

  // The one add of the builder image, under its own timeout and no caller's
  // signal; once it settles, the next add starts afresh
  const createBuilderImage = async (ref: string): Promise<ImageRecord> => {
    const pullMs = deps.builderImagePullMs ?? BUILDER_IMAGE_PULL_MS;
    const timeout = deps.startPullLimit?.(pullMs) ?? AbortSignal.timeout(pullMs);

    // a later step that fails after the limit is no pull that timed out
    const step = { pulled: false };

    try {
      return await writer.createImageOnHost(ref, BUILDER_IMAGE, {
        signal: timeout,
        onPulled: () => {
          step.pulled = true;
        },
      });
    } catch (error) {
      const reason =
        timeout.aborted && !step.pulled
          ? `the pull did not finish in ${formatPullLimit(pullMs)}; on a slow link, pull ${ref} on the host engine first (docker pull ${ref}), and impd takes it from there`
          : readErrorMessage(error);

      throw new ORPCError('SERVICE_UNAVAILABLE', {
        message: `impd cannot add its builder image ${ref} (IMP_BUILD_IMAGE) from the host engine, so no image add or build can run: ${reason}`,
      });
    }
  };

  const loadBuilderImage = async (signal?: AbortSignal): Promise<void> => {
    const ref = deps.config.build.image;

    const image = await findImageByName(deps.db, BUILDER_IMAGE);

    if (image?.ref === ref) {
      return;
    }

    // a call while an add is in flight joins it, whatever ref it adds
    await waitForPull(
      builderImage.run(BUILDER_IMAGE, () => createBuilderImage(ref)),
      signal,
    );
  };

  return {
    addImage: (ref, name, options) =>
      createImageFromRef(ref, name, false, {
        ...options,
        signal: options?.signal ?? new AbortController().signal,
      }),
    ensureBuilderImage: loadBuilderImage,

    // impd's builder image does not count: a seed that failed after the
    // builder image landed tries again at the next start
    seedDefaultImage: async () => {
      const images = await listImages(deps.db);

      if (images.every((image) => image.name === BUILDER_IMAGE)) {
        await createImageFromRef(SEED_REF, FALLBACK_DEFAULT_IMAGE, true, {
          signal: new AbortController().signal,
        });
      }
    },
  };
}

// the pull's limit as the error names it: 10 minutes, or seconds in a test
function formatPullLimit(pullMs: number): string {
  return pullMs >= 60_000 ? `${String(pullMs / 60_000)} minutes` : `${String(pullMs / 1000)} s`;
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

// The reference with the tag the engine would assume written out, so the
// pull, the log and the error name what is fetched: `ubuntu` is
// `ubuntu:latest`
function formatExplicitRef(ref: string): string {
  const [withoutDigest = ''] = ref.split('@');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const hasTag = withoutDigest.includes(':', lastSlash + 1);

  return ref.includes('@') || hasTag ? ref : `${ref}:latest`;
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
