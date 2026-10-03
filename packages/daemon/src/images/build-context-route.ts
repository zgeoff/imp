import { mkdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_BUILD_STREAM_TYPE, ImageBuildQuerySchema } from '@imp/api';
import type { Image, ImageBuildPhase, ImageBuildQuery } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { ApiAudit } from '../audit/api-audit';
import { checkAccess, findAccess } from '../auth/access-policy';
import type { Caller } from '../auth/caller';
import type { Config } from '../config';
import type { ImageRecord } from '../db/images';
import { readErrorMessage } from '../read-error-message';
import { buildUploadsDir } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import { createBuildEventStream } from './build-event-stream';
import type { ImageService } from './image-service';

// builds that may stream at once; each holds up to buildContextMaxBytes on disk
const MAX_BUILDS = 4;
const PROCEDURE = 'images.build';

function readNoSecret(): Promise<null> {
  return Promise.resolve(null);
}

export interface BuildContextRoute {
  // `toApi` turns the image into what the API shows
  readonly handle: (
    request: Request,
    caller: Readonly<Caller>,
    toApi: (image: ImageRecord) => Image,
  ) => Promise<Response>;
}

export interface BuildContextDeps {
  readonly config: Pick<Config, 'dataDir' | 'buildContextMaxBytes'>;
  readonly images: Pick<ImageService, 'buildImageFromContext'>;

  // holds room for the uploaded tar while it is on disk
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;
  readonly audit: ApiAudit;
  readonly now: () => number;

  // the gap between progress lines of a streamed build; BUILD_KEEPALIVE_MS
  readonly keepaliveMs: number;
}

// an error as the route answers it, with the code an oRPC call would give
interface BuildFailure {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

// a build's end: the image as the API shows it, or its failure
type BuildOutcome =
  | { readonly ok: true; readonly image: Image }
  | { readonly ok: false; readonly failure: BuildFailure };

// `POST /images/build` (docs/guides/images.md#build-an-image): the context
// streams to a temp file, never into memory, and the build reads it from
// there. Clears what an earlier impd left in the uploads directory.
export function createBuildContextRoute(deps: BuildContextDeps): BuildContextRoute {
  const uploadsDir = buildUploadsDir(deps.config.dataDir);

  rmSync(uploadsDir, { recursive: true, force: true });
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

  const running = { count: 0 };

  // a build slot, held from before the upload until the build ends; the
  // answer frees it
  const claimSlot = (): (() => void) => {
    if (running.count >= MAX_BUILDS) {
      throw new ORPCError('TOO_MANY_REQUESTS', {
        message: `${String(MAX_BUILDS)} image builds are already uploading or running; try again`,
      });
    }

    running.count += 1;

    return () => {
      running.count -= 1;
    };
  };

  const runBuild = async (
    request: Request,
    query: ImageBuildQuery,
    limitBytes: number,
    signal: AbortSignal,
    setPhase: (phase: ImageBuildPhase) => void,
  ): Promise<ImageRecord> => {
    const tarPath = join(uploadsDir, `${Bun.randomUUIDv7()}.tar`);

    try {
      return await deps.diskBudget.withRoom(limitBytes, async () => {
        await writeBody(request, tarPath, limitBytes, deps.config.buildContextMaxBytes);

        signal.throwIfAborted();

        setPhase('build');

        return deps.images.buildImageFromContext(tarPath, query.name, query.dockerfile, signal);
      });
    } finally {
      rmSync(tarPath, { force: true });
    }
  };

  return {
    handle: async (request, caller, toApi) => {
      const startedAt = deps.now();
      const params = Object.fromEntries(new URL(request.url).searchParams);
      const parsed = ImageBuildQuerySchema.safeParse(params);

      // images.build is host-wide, so no secret is read
      const denial = await checkAccess(findAccess(PROCEDURE), caller, params, readNoSecret);

      // writes the audit row with what was thrown
      const writeFailure = (error: unknown): BuildFailure => {
        deps.audit.record({ procedure: PROCEDURE, actor: caller, impName: null, startedAt }, error);

        const known =
          error instanceof ORPCError
            ? error
            : new ORPCError('INTERNAL_SERVER_ERROR', { message: readErrorMessage(error) });

        return { code: String(known.code), message: known.message, status: known.status };
      };

      const sendFailure = (error: unknown): Response => sendError(writeFailure(error));

      if (denial !== null) {
        return sendFailure(new ORPCError('FORBIDDEN', { message: denial.message }));
      }

      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');

        return sendFailure(new ORPCError('BAD_REQUEST', { message }));
      }

      // refused with a real status, before a stream answers 200
      let reserved: { readonly limitBytes: number; readonly release: () => void };

      try {
        reserved = {
          limitBytes: readLimit(request, deps.config.buildContextMaxBytes),
          release: claimSlot(),
        };
      } catch (error) {
        return sendFailure(error);
      }

      const runToOutcome = async (
        signal: AbortSignal,
        setPhase: (phase: ImageBuildPhase) => void,
      ): Promise<BuildOutcome> => {
        try {
          const image = await runBuild(request, parsed.data, reserved.limitBytes, signal, setPhase);

          deps.audit.record(
            { procedure: PROCEDURE, actor: caller, impName: null, startedAt },
            null,
          );

          return { ok: true, image: toApi(image) };
        } catch (error) {
          // a client that went is in the audit, not the log
          if (!(error instanceof ORPCError) && !signal.aborted) {
            console.error('impd: image build from an upload failed:', error);
          }

          return { ok: false, failure: writeFailure(error) };
        } finally {
          reserved.release();
        }
      };

      if (isStreamAccepted(request)) {
        return createBuildEventStream(
          request.signal,
          async (signal, setPhase) => {
            const outcome = await runToOutcome(signal, setPhase);

            return outcome.ok
              ? { type: 'image', image: outcome.image }
              : { type: 'error', code: outcome.failure.code, message: outcome.failure.message };
          },
          { keepaliveMs: deps.keepaliveMs, now: deps.now },
        );
      }

      const outcome = await runToOutcome(request.signal, () => {
        // the JSON answer shows no phase
      });

      return outcome.ok ? Response.json(outcome.image) : sendError(outcome.failure);
    },
  };
}

// a client from before the stream sends no Accept, and gets JSON at the end
function isStreamAccepted(request: Request): boolean {
  return request.headers.get('accept')?.includes(IMAGE_BUILD_STREAM_TYPE) === true;
}

// answered with its code, as oRPC would
function sendError(failure: BuildFailure): Response {
  return Response.json(
    { code: failure.code, message: failure.message },
    { status: failure.status },
  );
}

// The bytes the body may hold. A Content-Length can only lower the limit:
// writeBody counts the bytes that come, whatever the header said.
function readLimit(request: Request, maxBytes: number): number {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);

  if (!Number.isSafeInteger(declared) || declared < 0) {
    return maxBytes;
  }

  if (declared > maxBytes) {
    throw buildTooLargeError(maxBytes);
  }

  return declared;
}

function buildTooLargeError(maxBytes: number): ORPCError<string, unknown> {
  const mib = String(Math.floor(maxBytes / 1024 ** 2));

  return new ORPCError('PAYLOAD_TOO_LARGE', {
    message: `the build context is larger than the limit, ${mib} MiB (IMP_BUILD_CONTEXT_MAX_MIB)`,
  });
}

// Streams the body to `path` and stops past `limitBytes`
async function writeBody(
  request: Request,
  path: string,
  limitBytes: number,
  maxBytes: number,
): Promise<void> {
  if (request.body === null) {
    throw new ORPCError('BAD_REQUEST', { message: 'the build context is missing: send a tar' });
  }

  const file = await open(path, 'wx', 0o600);

  let written = 0;

  try {
    for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
      written += chunk.byteLength;

      if (written > maxBytes) {
        throw buildTooLargeError(maxBytes);
      }

      if (written > limitBytes) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'the body is longer than its Content-Length',
        });
      }

      await file.write(chunk);
    }
  } finally {
    await file.close();
  }

  if (written === 0) {
    throw new ORPCError('BAD_REQUEST', { message: 'the build context is empty: send a tar' });
  }
}
