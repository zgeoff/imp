import * as z from 'zod';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { DockerBuildError } from './docker-build';
import type { GuestExec } from './guest-exec';
import { ImageLimitError } from './image-limit-error';
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

// a build's digest names no Docker image ID, nor a template's `imp-<uuid>`
const DIGEST_PREFIX = 'imp-build-';
const DIGEST_DOMAIN = 'imp build image v1\n';

export interface ExportedImage {
  // DIGEST_PREFIX and the sha256 of DIGEST_DOMAIN, the Config's JSON with
  // its length in front, and the export, as impd read them: the builder
  // names nothing on the host
  readonly digest: string;
  readonly config: z.infer<typeof OciConfigSchema>;
}

export interface ExportLimits {
  // the archive's bytes, and the disk its entries take: their logical sizes,
  // so sparse files count in full, in whole blocks
  readonly maxBytes: number;

  // tar's own count of what it unpacked, so a stream cannot hide entries
  // from a second parser
  readonly maxFiles: number;
}

// the digest's hash, once the export has gone into it
function createImageHash(configText: string): Bun.CryptoHasher {
  const config = new TextEncoder().encode(configText);
  const length = new Uint8Array(8);

  new DataView(length.buffer).setBigUint64(0, BigInt(config.byteLength));

  const hash = new Bun.CryptoHasher('sha256');

  hash.update(DIGEST_DOMAIN);
  hash.update(length);
  hash.update(config);

  return hash;
}

// a filesystem block; every entry is counted as at least one
const BLOCK_BYTES = 4096;

// An entry's share of the disk from its `tar -vv` line: the third field is
// its logical size, a sparse file's full length. Links, devices and empty
// files still take a block.
function readAllocatedBytes(line: string): number {
  const size = line.trim().split(/\s+/v)[2] ?? '';
  const bytes = /^\d+$/v.test(size) ? Number(size) : 0;

  return Math.max(1, Math.ceil(bytes / BLOCK_BYTES)) * BLOCK_BYTES;
}

// tar -vv prints one line per entry it unpacks, names escaped; past either
// limit it is killed
async function countUnpacked(
  stdout: ReadableStream<Uint8Array>,
  limits: Readonly<ExportLimits>,
  onOver: (limit: 'bytes' | 'files') => void,
): Promise<void> {
  const decoder = new TextDecoder();

  const counted = { lines: 0, bytes: 0, rest: '' };

  for await (const chunk of stdout as AsyncIterable<Uint8Array>) {
    const lines = `${counted.rest}${decoder.decode(chunk, { stream: true })}`.split('\n');

    counted.rest = lines.pop() ?? '';

    for (const line of lines) {
      counted.lines += 1;
      counted.bytes += readAllocatedBytes(line);
    }

    if (counted.bytes > limits.maxBytes) {
      onOver('bytes');

      return;
    }

    if (counted.lines > limits.maxFiles) {
      onOver('files');

      return;
    }
  }
}

// The built image's filesystem, streamed out of the builder into root by
// the same tar as every image add, as root; no host engine reads it.
// Everything the builder sends here is data the build could have shaped.
export async function writeGuestTree(
  exec: GuestExec,
  root: string,
  limits: Readonly<ExportLimits>,
  signal: AbortSignal,
): Promise<ExportedImage> {
  const maxBytes = limits.maxBytes;

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

  const tar = Bun.spawn([...UNPACK_TAR_ARGS, '-vv', '--quoting-style=escape', '-C', root], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C' },
  });

  const hash = createImageHash(configText);
  const sent = { bytes: 0 };
  const unpacked: { over?: 'bytes' | 'files' } = {};

  const counting = countUnpacked(tar.stdout, limits, (limit) => {
    unpacked.over = limit;

    tar.kill();
  });

  const assertWithinLimits = () => {
    const over = unpacked.over;

    if (over !== undefined) {
      const max = over === 'bytes' ? maxBytes : limits.maxFiles;

      throw new ImageLimitError(over, max);
    }
  };

  const stderrText = new Response(tar.stderr).text();

  try {
    const exported = await exec(['docker', 'export', containerId], {
      signal,
      onStdout: async (chunk) => {
        sent.bytes += chunk.byteLength;

        if (sent.bytes > maxBytes) {
          throw new ImageLimitError('bytes', maxBytes);
        }

        assertWithinLimits();

        hash.update(chunk);

        await tar.stdin.write(chunk);
        await tar.stdin.flush();
      },
    });

    if (exported.exitCode !== 0) {
      throw new Error(`docker export in the builder: ${exported.stderr.trim()}`);
    }

    await tar.stdin.end();

    const [exitCode, stderr] = await Promise.all([tar.exited, stderrText, counting]);

    assertWithinLimits();
    assertUnpacked({ exitCode, stdout: '', stderr });
  } catch (error) {
    tar.kill();

    // a write to the tar it killed fails first
    assertWithinLimits();
    throw error;
  }

  return { digest: `${DIGEST_PREFIX}${hash.digest('hex')}`, config };
}
