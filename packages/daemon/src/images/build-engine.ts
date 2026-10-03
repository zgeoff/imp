import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import type { ExternalImage } from './dockerfile-check';
import { PIN_INSPECT_FORMAT, PinInspectSchema, normalizePlatform } from './image-pin';
import type { PinInspect } from './image-pin';

// the tail of a failed pull's message the client gets
const FAILURE_MAX_CHARS = 4000;

interface EngineResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// one docker CLI command against the engine: the host's, or a builder's
export type EngineRun = (argv: readonly string[], signal: AbortSignal) => Promise<EngineResult>;

// What impd asks of the engine a build runs on before the build: it pins
// every image the Dockerfile names on the engine that builds it
// (docs/guides/images.md#isolated-builds).
export interface BuildEngine {
  // the engine's platform, which a build without one runs for
  readonly readPlatform: (signal: AbortSignal) => Promise<string>;

  // what impd reads of the image the engine has for ref, pulled first when
  // it lacks it
  readonly loadImage: (image: Readonly<ExternalImage>, signal: AbortSignal) => Promise<PinInspect>;

  // Engines before 29.6.0 fetch the BUILDKIT_SYNTAX frontend only through
  // a client session, which a host build lacks; pulled by digest first.
  readonly loadFrontend: (signal: AbortSignal) => Promise<void>;
}

export function createBuildEngine(run: EngineRun): BuildEngine {
  const runAborting = async (argv: readonly string[], signal: AbortSignal) => {
    const result = await run(argv, signal);

    signal.throwIfAborted();

    return result;
  };

  const readPinInspect = async (ref: string, signal: AbortSignal): Promise<PinInspect | null> => {
    const inspected = await runAborting(
      ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, ref],
      signal,
    );

    if (inspected.exitCode !== 0) {
      return null;
    }

    return PinInspectSchema.parse(JSON.parse(inspected.stdout));
  };

  return {
    readPlatform: async (signal) => {
      const version = await runAborting(
        ['docker', 'version', '--format', '{{json .Server.Os}} {{json .Server.Arch}}'],
        signal,
      );

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
    },
    loadImage: async (image, signal) => {
      const ref = image.ref;

      const local = await readPinInspect(ref, signal);

      if (local !== null) {
        return local;
      }

      const pulled = await runAborting(['docker', 'pull', '--quiet', ref], signal);

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
    },
    loadFrontend: async (signal) => {
      const inspected = await runAborting(
        ['docker', 'image', 'inspect', '--format', '{{.Id}}', DOCKERFILE_FRONTEND],
        signal,
      );

      if (inspected.exitCode === 0) {
        return;
      }

      const pulled = await runAborting(['docker', 'pull', '--quiet', DOCKERFILE_FRONTEND], signal);

      if (pulled.exitCode !== 0) {
        throw new ORPCError('BAD_GATEWAY', {
          message: `the Dockerfile frontend ${DOCKERFILE_FRONTEND}: the pull failed: ${pulled.stderr.trim().slice(-FAILURE_MAX_CHARS)}`,
        });
      }

      console.log(`impd: pulled the Dockerfile frontend ${DOCKERFILE_FRONTEND}`);
    },
  };
}
