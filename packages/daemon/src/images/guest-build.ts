import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { DockerBuildError } from './docker-build';
import type { GuestExec } from './guest-exec';
import { ImageLimitError } from './image-limit-error';
import { PIN_INSPECT_FORMAT, PinInspectSchema, formatPlatform, pickRepoDigest } from './image-pin';
import { planRootfsOverhead } from './rootfs-plan';
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

export interface GuestPullOptions {
  // the reference with its tag or digest written out
  readonly ref: string;

  // the builder engine's own, `linux/amd64`
  readonly platform: string;
  readonly signal: AbortSignal;
}

// An add's pull on the builder's engine, for a platform named in full, as
// the builder's one image; returns the registry digest it reports, for the
// log only.
export async function loadGuestImage(
  exec: GuestExec,
  options: Readonly<GuestPullOptions>,
): Promise<string | null> {
  const ref = options.ref;
  const signal = options.signal;

  const pulled = await exec(['docker', 'pull', '--quiet', '--platform', options.platform, ref], {
    signal,
  });

  if (pulled.exitCode !== 0) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the pull of ${ref} in the builder failed: ${pulled.stderr.trim().slice(-LOG_MAX_CHARS)}`,
    });
  }

  const inspected = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, ref],
    {
      signal,
    },
  );

  if (inspected.exitCode !== 0) {
    throw new Error(`docker image inspect ${ref} in the builder: ${inspected.stderr.trim()}`);
  }

  const inspect = PinInspectSchema.parse(JSON.parse(inspected.stdout));
  const imagePlatform = formatPlatform(inspect.Os, inspect.Architecture);

  if (imagePlatform !== options.platform) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${ref} pulled for ${imagePlatform}, not ${options.platform}`,
    });
  }

  const tagged = await exec(['docker', 'tag', ref, GUEST_BUILD_TAG], { signal });

  if (tagged.exitCode !== 0) {
    throw new Error(`docker tag in the builder: ${tagged.stderr.trim()}`);
  }

  return pickRepoDigest(ref, inspect.RepoDigests ?? []);
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

  // how long the export may send nothing; EXPORT_IDLE_MS, but for tests
  readonly idleMs?: number;
}

// how long a builder's export may send nothing before impd ends it
const EXPORT_IDLE_MS = 120_000;

// how far ahead of the export the disk is held at a time
const GROW_STEP_BYTES = 256 * 1024 ** 2;

// the export's end when its tar fails first
const TAR_STOPPED = new Error('tar stopped before the export ended');

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

// tar -vv prints one line per entry it unpacks, names escaped, and a
// "Creating directory:" line for each parent a member names that the
// archive does not; past either limit it is killed
async function countUnpacked(
  stdout: ReadableStream<Uint8Array>,
  limits: Readonly<ExportLimits>,
  onCounted: (bytes: number) => void,
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

    onCounted(counted.bytes);

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
  grow: (totalBytes: number) => Promise<void> = () => Promise.resolve(),
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
  const unpacked: { over?: 'bytes' | 'files'; ended?: boolean } = {};

  // ends the export, which a stalled builder would keep open, as soon as
  // its tar is gone or it sends nothing for idleMs
  const stopExport = new AbortController();

  const readMax = (limit: 'bytes' | 'files') => (limit === 'bytes' ? maxBytes : limits.maxFiles);
  const idleMs = limits.idleMs ?? EXPORT_IDLE_MS;

  // tar's listing may come only as it exits, which can be after the end of
  // the archive and before the end of the export
  const listed = { bytes: 0 };
  const held = { bytes: 0 };

  // twice the larger of the archive and the disk its entries take: the tree,
  // then its ext4 file, with the ext4 file's journal; in steps, ahead of what
  // tar has listed
  const growHold = async () => {
    const tree = Math.max(sent.bytes, listed.bytes);
    const needed = 2 * tree + planRootfsOverhead(tree);

    if (needed > held.bytes) {
      held.bytes = (Math.floor(needed / GROW_STEP_BYTES) + 1) * GROW_STEP_BYTES;

      await grow(held.bytes);
    }
  };

  const onCounted = (bytes: number) => {
    listed.bytes = bytes;
  };

  const counting = countUnpacked(tar.stdout, limits, onCounted, (limit) => {
    unpacked.over = limit;

    const max = readMax(limit);

    tar.kill();
    stopExport.abort(new ImageLimitError(limit, max));
  });

  const waitForTar = async () => {
    const code = await tar.exited;

    if (code !== 0 && unpacked.ended !== true) {
      stopExport.abort(TAR_STOPPED);
    }
  };

  void waitForTar();

  const assertWithinLimits = () => {
    const over = unpacked.over;

    if (over !== undefined) {
      throw new ImageLimitError(over, readMax(over));
    }
  };

  const stopIdle = () => {
    stopExport.abort(
      new Error(`docker export in the builder sent nothing in ${String(idleMs / 1000)} s`),
    );
  };

  const idle = { timer: setTimeout(stopIdle, idleMs) };

  const stderrText = new Response(tar.stderr).text();

  try {
    const exported = await exec(['docker', 'export', containerId], {
      signal: AbortSignal.any([signal, stopExport.signal]),
      onStdout: async (chunk) => {
        idle.timer.refresh();

        sent.bytes += chunk.byteLength;

        if (sent.bytes > maxBytes) {
          throw new ImageLimitError('bytes', maxBytes);
        }

        assertWithinLimits();

        await growHold();

        hash.update(chunk);

        await tar.stdin.write(chunk);
        await tar.stdin.flush();
      },
    });

    if (exported.exitCode !== 0) {
      throw new Error(`docker export in the builder: ${exported.stderr.trim()}`);
    }

    unpacked.ended = true;

    await tar.stdin.end();

    const [exitCode, stderr] = await Promise.all([tar.exited, stderrText, counting]);

    assertWithinLimits();
    assertUnpacked({ exitCode, stdout: '', stderr });

    // what tar listed after the last chunk
    await growHold();
  } catch (error) {
    tar.kill();

    // a write to the tar it killed fails first
    assertWithinLimits();

    if (stopExport.signal.reason === TAR_STOPPED) {
      const [exitCode, stderr] = await Promise.all([tar.exited, stderrText]);

      assertUnpacked({ exitCode, stdout: '', stderr });
    }

    throw error;
  } finally {
    clearTimeout(idle.timer);
  }

  return { digest: `${DIGEST_PREFIX}${hash.digest('hex')}`, config };
}
