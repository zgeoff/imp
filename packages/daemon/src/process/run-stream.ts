// A command whose stdout is read as it comes: `done` resolves once it exits
// 0, and rejects with its stderr otherwise. `stop` kills it.
export interface StreamedCommand {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly done: Promise<void>;
  readonly stop: () => void;
}

// what a ZFS move spawns; a fake ZFS in tests
export interface StreamRunner {
  readonly readFrom: (argv: readonly string[]) => StreamedCommand;

  // feeds `input` to the command's stdin; rejects with its stderr on a
  // non-zero exit
  readonly writeTo: (argv: readonly string[], input: ReadableStream<Uint8Array>) => Promise<void>;
}

export function createStreamRunner(): StreamRunner {
  return {
    readFrom: (argv) => {
      const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const state = { isStopped: false };

      const checkExit = async () => {
        const stderr = new Response(child.stderr).text();

        const exitCode = await child.exited;

        // a stop is the caller's choice, not a failure to report
        if (exitCode !== 0 && !state.isStopped) {
          const message = await stderr;

          throw new Error(`${argv.join(' ')} exited ${String(exitCode)}: ${message.trim()}`);
        }
      };

      return {
        stdout: child.stdout,
        done: checkExit(),
        stop: () => {
          state.isStopped = true;

          child.kill();
        },
      };
    },
    writeTo: async (argv, input) => {
      const child = Bun.spawn([...argv], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });

      const stderr = new Response(child.stderr).text();

      try {
        for await (const chunk of input) {
          await child.stdin.write(chunk);
        }

        await child.stdin.end();
      } catch (error) {
        // a command that exited early closed its stdin: its stderr says why
        if (child.exitCode !== null) {
          await requireExitZero(argv, child.exited, stderr);
        }

        child.kill();

        await child.exited;

        throw error;
      }

      await requireExitZero(argv, child.exited, stderr);
    },
  };
}

async function requireExitZero(
  argv: readonly string[],
  exited: Promise<number>,
  stderr: Promise<string>,
): Promise<void> {
  const exitCode = await exited;

  if (exitCode !== 0) {
    const message = await stderr;

    throw new Error(`${argv.join(' ')} exited ${String(exitCode)}: ${message.trim()}`);
  }
}
