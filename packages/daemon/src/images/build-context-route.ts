import { mkdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageBuildQuerySchema } from '@imp/api';
import type { ImageBuildQuery } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { ApiAudit } from '../audit/api-audit';
import { checkAccess, findAccess } from '../auth/access-policy';
import type { Caller } from '../auth/caller';
import type { Config } from '../config';
import type { ImageRecord } from '../db/images';
import { readErrorMessage } from '../read-error-message';
import { buildUploadsDir } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import type { ImageService } from './image-service';

// builds that may stream at once; each holds up to buildContextMaxBytes on disk
const MAX_BUILDS = 4;
const PROCEDURE = 'images.build';

export interface BuildContextRoute {
  // `toApi` turns the image into what the API shows
  readonly handle: (
    request: Request,
    caller: Readonly<Caller>,
    toApi: (image: ImageRecord) => unknown,
  ) => Promise<Response>;
}

interface BuildContextDeps {
  readonly config: Pick<Config, 'dataDir' | 'buildContextMaxBytes'>;
  readonly images: Pick<ImageService, 'buildImageFromContext'>;

  // holds room for the uploaded tar while it is on disk
  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;
  readonly audit: ApiAudit;
  readonly now: () => number;
}

// `POST /images/build` (docs/guides/images.md#build-an-image): the context
// streams to a temp file, never into memory, and the build reads it from
// there. Clears what an earlier impd left in the uploads directory.
export function createBuildContextRoute(deps: BuildContextDeps): BuildContextRoute {
  const uploadsDir = buildUploadsDir(deps.config.dataDir);

  rmSync(uploadsDir, { recursive: true, force: true });
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

  const running = { count: 0 };

  const runBuild = async (request: Request, query: ImageBuildQuery): Promise<ImageRecord> => {
    const limitBytes = readLimit(request, deps.config.buildContextMaxBytes);

    if (running.count >= MAX_BUILDS) {
      throw new ORPCError('TOO_MANY_REQUESTS', {
        message: `${String(MAX_BUILDS)} image builds are already uploading or running; try again`,
      });
    }

    running.count += 1;

    const tarPath = join(uploadsDir, `${Bun.randomUUIDv7()}.tar`);

    try {
      return await deps.diskBudget.withRoom(limitBytes, async () => {
        await writeBody(request, tarPath, limitBytes, deps.config.buildContextMaxBytes);

        request.signal.throwIfAborted();

        return deps.images.buildImageFromContext(
          tarPath,
          query.name,
          query.dockerfile,
          request.signal,
        );
      });
    } finally {
      running.count -= 1;

      rmSync(tarPath, { force: true });
    }
  };

  return {
    handle: async (request, caller, toApi) => {
      const startedAt = deps.now();
      const params = Object.fromEntries(new URL(request.url).searchParams);
      const parsed = ImageBuildQuerySchema.safeParse(params);
      const denial = checkAccess(findAccess(PROCEDURE), caller, params);

      // audited with what was thrown; answered with its code, as oRPC would
      const sendFailure = (error: unknown): Response => {
        deps.audit.record({ procedure: PROCEDURE, actor: caller, impName: null, startedAt }, error);

        const known =
          error instanceof ORPCError
            ? error
            : new ORPCError('INTERNAL_SERVER_ERROR', { message: readErrorMessage(error) });

        return Response.json(
          { code: String(known.code), message: known.message },
          { status: known.status },
        );
      };

      if (denial !== null) {
        return sendFailure(new ORPCError('FORBIDDEN', { message: denial }));
      }

      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');

        return sendFailure(new ORPCError('BAD_REQUEST', { message }));
      }

      try {
        const image = await runBuild(request, parsed.data);

        deps.audit.record({ procedure: PROCEDURE, actor: caller, impName: null, startedAt }, null);

        return Response.json(toApi(image));
      } catch (error) {
        // a client that went is in the audit, not the log
        if (!(error instanceof ORPCError) && !request.signal.aborted) {
          console.error('impd: image build from an upload failed:', error);
        }

        return sendFailure(error);
      }
    },
  };
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
