import { ORPCError } from '@orpc/server';
import type { Config } from '../config';
import { listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { ImpService } from '../imps/imp-service';
import { readErrorMessage } from '../read-error-message';
import { createGuestExec } from './guest-exec';
import type { GuestExec } from './guest-exec';

// the image every builder boots, IMP_BUILD_IMAGE; a name no client may take
export const BUILDER_IMAGE = 'imp-builder';

// how long a new builder's engine gets to answer, and how often impd asks
const ENGINE_READY_MS = 60_000;
const ENGINE_POLL_MS = 500;
const NAME_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

// One builder imp per isolated build (docs/guides/images.md#isolated-builds):
// the public egress policy, the governor's and the disk budget's admission
// as any imp, and destroyed at the build's end or impd's next start.
export interface Builders {
  readonly withBuilder: <T>(
    signal: AbortSignal,
    run: (exec: GuestExec) => Promise<T>,
  ) => Promise<T>;

  // the builders a stopped impd left behind
  readonly removeLeftovers: () => Promise<void>;
}

export interface BuildersDeps {
  readonly config: Pick<Config, 'build'>;
  readonly db: ImpDatabase;
  readonly imps: Pick<ImpService, 'createImp' | 'destroyImp' | 'openBuilderExec'>;

  // adds IMP_BUILD_IMAGE as BUILDER_IMAGE, when it is not that already
  readonly ensureImage: () => Promise<void>;
  readonly log: (message: string) => void;
}

function pickBuilderName(): string {
  const picks = Array.from({ length: 8 }, () => Math.random() * NAME_ALPHABET.length);

  return `imp-build-${picks.map((pick) => NAME_ALPHABET[Math.floor(pick)]).join('')}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ORPCError && error.code === 'NOT_FOUND';
}

// a builder's dockerd starts with the guest, a little after its agent
async function waitForEngine(exec: GuestExec, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + ENGINE_READY_MS;

  for (;;) {
    const info = await exec(['docker', 'info', '--format', '{{.ServerVersion}}'], {
      signal,
      timeoutMs: ENGINE_READY_MS,
    });

    if (info.exitCode === 0) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `the builder's engine did not answer in ${String(ENGINE_READY_MS / 1000)} s: ${info.stderr.trim()}`,
      );
    }

    await Bun.sleep(ENGINE_POLL_MS);
  }
}

export function createBuilders(deps: BuildersDeps): Builders {
  const removeBuilder = async (name: string): Promise<void> => {
    try {
      await deps.imps.destroyImp(name);
    } catch (error) {
      if (!isNotFound(error)) {
        deps.log(`impd: image build: could not remove builder ${name}: ${readErrorMessage(error)}`);
      }
    }
  };

  return {
    withBuilder: async (signal, run) => {
      await deps.ensureImage();

      signal.throwIfAborted();

      const name = pickBuilderName();
      const started = performance.now();

      try {
        // the create fails where the firewall cannot hold the public policy,
        // and where the governor or the disk budget has no room
        await deps.imps.createImp({
          name,
          image: BUILDER_IMAGE,
          memoryMib: deps.config.build.memoryMib,
          diskMib: Math.ceil(deps.config.build.diskBytes / 1024 ** 2),
          policy: { mode: 'public', allow: [] },
          kind: 'builder',
        });

        const exec = createGuestExec((request) => deps.imps.openBuilderExec(name, request));

        await waitForEngine(exec, signal);

        const readyMs = Math.round(performance.now() - started);

        deps.log(`impd: image build: builder ${name} ready in ${String(readyMs)}ms`);

        return await run(exec);
      } finally {
        await removeBuilder(name);
      }
    },
    removeLeftovers: async () => {
      const imps = await listImps(deps.db);

      for (const imp of imps.filter((each) => each.kind === 'builder')) {
        deps.log(`impd: removing builder ${imp.name}, which a stopped impd left`);

        await removeBuilder(imp.name);
      }
    },
  };
}
