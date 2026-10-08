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

// how often impd tries again to remove a builder that survived its removal
const REMOVE_RETRY_MS = 30_000;

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
  readonly imps: Pick<ImpService, 'createImp' | 'destroyImpId' | 'openBuilderExec'>;

  // adds IMP_BUILD_IMAGE as BUILDER_IMAGE, when it is not that already
  readonly ensureImage: (signal: AbortSignal) => Promise<void>;
  readonly log: (message: string) => void;

  // REMOVE_RETRY_MS, but for tests
  readonly removeRetryMs?: number;

  // the engine wait's clock; Date.now and Bun.sleep by default
  readonly engineClock?: EngineClock;
}

function pickBuilderName(): string {
  const picks = Array.from({ length: 8 }, () => Math.random() * NAME_ALPHABET.length);

  return `imp-build-${picks.map((pick) => NAME_ALPHABET[Math.floor(pick)]).join('')}`;
}

// how the engine wait reads the time and waits between its asks
interface EngineClock {
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
}

// a builder's dockerd starts with the guest, a little after its agent
async function waitForEngine(
  exec: GuestExec,
  signal: AbortSignal,
  clock: Readonly<EngineClock>,
): Promise<void> {
  const deadline = clock.now() + ENGINE_READY_MS;

  for (;;) {
    const info = await exec(['docker', 'info', '--format', '{{.ServerVersion}}'], {
      signal,
      timeoutMs: ENGINE_READY_MS,
    });

    if (info.exitCode === 0) {
      return;
    }

    if (clock.now() > deadline) {
      throw new Error(
        `the builder's engine did not answer in ${String(ENGINE_READY_MS / 1000)} s: ${info.stderr.trim()}`,
      );
    }

    await clock.wait(ENGINE_POLL_MS);
  }
}

export function createBuilders(deps: BuildersDeps): Builders {
  const retryMs = deps.removeRetryMs ?? REMOVE_RETRY_MS;
  const engineClock = deps.engineClock ?? { now: Date.now, wait: Bun.sleep };

  const retrying = new Set<string>();

  // true once the builder is gone; a builder that survives holds its memory
  // and disk, and refuses sleep, so it is an error. By id, and only a
  // builder: an imp that took its name or its id stays.
  const removeOnce = async (id: string, name: string): Promise<boolean> => {
    try {
      await deps.imps.destroyImpId(id, 'builder');

      return true;
    } catch (error) {
      deps.log(
        `impd: image build: ERROR: builder ${name} survives its removal, tried again every ${String(retryMs / 1000)} s: ${readErrorMessage(error)}`,
      );

      return false;
    }
  };

  const removeLater = (id: string, name: string): void => {
    if (retrying.has(id)) {
      return;
    }

    retrying.add(id);

    const tryAgain = async () => {
      const gone = await removeOnce(id, name);

      if (gone) {
        retrying.delete(id);
        deps.log(`impd: image build: removed builder ${name}`);

        return;
      }

      setTimeout(() => void tryAgain(), retryMs).unref();
    };

    setTimeout(() => void tryAgain(), retryMs).unref();
  };

  // a builder that survives impd keeps trying to remove
  const removeBuilder = async (id: string, name: string): Promise<void> => {
    const gone = await removeOnce(id, name);

    if (!gone) {
      removeLater(id, name);
    }
  };

  return {
    withBuilder: async (signal, run) => {
      await deps.ensureImage(signal);

      signal.throwIfAborted();

      const id = Bun.randomUUIDv7();
      const name = pickBuilderName();
      const started = performance.now();

      try {
        // the create fails where the firewall cannot hold the public policy,
        // and where the governor or the disk budget has no room
        await deps.imps.createImp({
          id,
          name,
          image: BUILDER_IMAGE,
          memoryMib: deps.config.build.memoryMib,
          diskMib: Math.ceil(deps.config.build.diskBytes / 1024 ** 2),
          policy: { mode: 'public', allow: [] },
          kind: 'builder',
        });

        const exec = createGuestExec((request) => deps.imps.openBuilderExec(name, request));

        await waitForEngine(exec, signal, engineClock);

        const readyMs = Math.round(performance.now() - started);

        deps.log(`impd: image build: builder ${name} ready in ${String(readyMs)}ms`);

        return await run(exec);
      } finally {
        // a builder that survives is logged and retried; a build it served
        // still stands, its image written
        await removeBuilder(id, name);
      }
    },
    removeLeftovers: async () => {
      const imps = await listImps(deps.db);

      for (const imp of imps.filter((each) => each.kind === 'builder')) {
        deps.log(`impd: removing builder ${imp.name}, which a stopped impd left`);

        await removeBuilder(imp.id, imp.name);
      }
    },
  };
}
