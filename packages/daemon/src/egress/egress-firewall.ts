import { readErrorMessage } from '../read-error-message';

// applies one nft script; throws with nft's reason
export type NftRunner = (script: string) => Promise<void>;

interface QueuedScript {
  readonly script: string;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

// The one writer of impd's nft table: scripts run in order, and those that
// wait while one runs go in a single `nft -f`. A failed batch runs again one
// script at a time, so a bad script fails only its own caller.
export function createNftWriter(run: NftRunner = runNft): (script: string) => Promise<void> {
  const queue: QueuedScript[] = [];
  const state = { running: false };

  const runBatch = async (batch: readonly QueuedScript[]): Promise<void> => {
    try {
      await run(batch.map((item) => item.script).join(''));

      for (const item of batch) {
        item.resolve();
      }

      return;
    } catch (error) {
      if (batch.length === 1) {
        batch[0]?.reject(error);

        return;
      }
    }

    for (const item of batch) {
      await runBatch([item]);
    }
  };

  const drain = async (): Promise<void> => {
    state.running = true;

    while (queue.length > 0) {
      await runBatch(queue.splice(0));
    }

    state.running = false;
  };

  return (script) => {
    const done = Promise.withResolvers<void>();

    queue.push({ script, resolve: done.resolve, reject: done.reject });

    if (!state.running) {
      void drain();
    }

    return done.promise;
  };
}

// `nft -f -` from `nftBin`, which is found on PATH unless it is a path
export function createNftRunner(nftBin = 'nft'): NftRunner {
  return async (script) => {
    const child = Bun.spawn([nftBin, '-f', '-'], {
      stdin: new TextEncoder().encode(script),
      stdout: 'ignore',
      stderr: 'pipe',

      // process.env as it is now, PATH included: Bun's own default is the
      // env impd started with
      env: process.env,
    });

    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

    if (exitCode !== 0) {
      throw new Error(`nft exited ${String(exitCode)}: ${stderr.trim().split('\n')[0] ?? ''}`);
    }
  };
}

export const runNft: NftRunner = createNftRunner();

// `nft` itself failed to start: a missing binary reads better this way
export function formatNftError(error: unknown): string {
  const message = readErrorMessage(error);

  return message.includes('ENOENT') ? 'nft is not installed' : message;
}
