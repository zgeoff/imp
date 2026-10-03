import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { DockerBuildError } from './docker-build';
import type { GuestExec } from './guest-exec';
import { UNPACK_TAR_ARGS, assertUnpacked } from './unpack-export';

// the tag of the one image a builder makes
const GUEST_BUILD_TAG = 'imp-build:latest';

// the tail of a failed build's log the client gets
const LOG_MAX_CHARS = 8000;
const ContainerIdSchema = z.string().regex(/^[a-f0-9]{64}$/v);

// the image's Config, as `docker image inspect` gives it; null for none
const OciConfigSchema = z.record(z.string(), z.unknown()).nullable();

export interface GuestBuildOptions {
  // the build context with its pinned Dockerfile, a tar file
  readonly tarPath: string;

  // the Dockerfile's path inside the context
  readonly dockerfile: string;
  readonly signal: AbortSignal;
}

// The build, on the builder's engine, its context on stdin. A failed build's
// log comes back in the error, capped.
export async function runGuestBuild(
  exec: GuestExec,
  options: Readonly<GuestBuildOptions>,
): Promise<void> {
  const result = await exec(
    [
      'docker',
      'build',
      '--progress=plain',
      '--build-arg',
      `BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND}`,
      '--tag',
      GUEST_BUILD_TAG,
      '--file',
      options.dockerfile,
      '-',
    ],
    { stdinPath: options.tarPath, signal: options.signal },
  );

  if (result.exitCode !== 0) {
    const log = `${result.stdout}${result.stderr}`.trim().slice(-LOG_MAX_CHARS);

    throw new DockerBuildError(`docker build failed:\n${log}`);
  }
}

// The export grew past IMP_BUILD_IMAGE_MAX_MIB
export class ImageTooLargeError extends ORPCError<'BAD_REQUEST', undefined> {
  override readonly name = 'ImageTooLargeError';

  constructor(maxBytes: number) {
    super('BAD_REQUEST', {
      message: `the built image's filesystem is over ${String(Math.floor(maxBytes / 1024 ** 2))} MiB (IMP_BUILD_IMAGE_MAX_MIB)`,
    });
  }
}

export interface ExportedImage {
  // sha256 of the Config's JSON and then the export, as impd read them: the
  // builder names nothing on the host
  readonly digest: string;
  readonly config: z.infer<typeof OciConfigSchema>;
}

// The built image's filesystem, streamed out of the builder into root by
// the same tar as every image add, as root; no host engine reads it.
// Everything the builder sends here is data the build could have shaped.
export async function writeGuestTree(
  exec: GuestExec,
  root: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ExportedImage> {
  const inspected = await exec(
    ['docker', 'image', 'inspect', '--format', '{{json .Config}}', GUEST_BUILD_TAG],
    { signal },
  );

  if (inspected.exitCode !== 0) {
    throw new Error(`docker image inspect in the builder: ${inspected.stderr.trim()}`);
  }

  const configText = inspected.stdout.trim();
  const config = OciConfigSchema.parse(JSON.parse(configText));

  const created = await exec(['docker', 'create', GUEST_BUILD_TAG, '/bin/true'], { signal });

  if (created.exitCode !== 0) {
    throw new Error(`docker create in the builder: ${created.stderr.trim()}`);
  }

  const containerId = ContainerIdSchema.parse(created.stdout.trim());

  const tar = Bun.spawn([...UNPACK_TAR_ARGS, '-C', root], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C' },
  });

  const hash = new Bun.CryptoHasher('sha256');

  hash.update(configText);

  const sent = { bytes: 0 };

  try {
    const exported = await exec(['docker', 'export', containerId], {
      signal,
      onStdout: async (chunk) => {
        sent.bytes += chunk.byteLength;

        if (sent.bytes > maxBytes) {
          throw new ImageTooLargeError(maxBytes);
        }

        hash.update(chunk);

        await tar.stdin.write(chunk);
        await tar.stdin.flush();
      },
    });

    if (exported.exitCode !== 0) {
      throw new Error(`docker export in the builder: ${exported.stderr.trim()}`);
    }

    await tar.stdin.end();

    const [exitCode, stdout, stderr] = await Promise.all([
      tar.exited,
      new Response(tar.stdout).text(),
      new Response(tar.stderr).text(),
    ]);

    assertUnpacked({ exitCode, stdout, stderr });
  } catch (error) {
    tar.kill();
    throw error;
  }

  return { digest: `sha256:${hash.digest('hex')}`, config };
}
