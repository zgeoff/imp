import { join } from 'node:path';
import { readImpEnv } from './imp-cli';
import { REPO_ROOT } from './instance';
import { waitFor } from './wait-for';

export interface ConsoleStep {
  // typed once the terminal shows this, or at once when null; text a shell
  // computes (console-$((40 + 2)) prints console-42) never matches the echo
  readonly after: string | null;
  readonly line: string;
}

// Runs `imp console NAME` on a pseudo-terminal, typing each line once the
// terminal shows what it waits for; returns the exit code and what the
// terminal showed, without carriage returns
export async function runConsole(
  name: string,
  steps: readonly ConsoleStep[],
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const impEnv = await readImpEnv();

  const decoder = new TextDecoder();

  let output = '';

  const proc = Bun.spawn([join(REPO_ROOT, 'scripts', 'imp'), 'console', name], {
    env: { ...process.env, ...impEnv },
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, data) => {
        output += decoder.decode(data, { stream: true });
      },
    },
  });

  const checkShown = (text: string) => {
    if (!output.includes(text)) {
      throw new Error(`it shows ${JSON.stringify(output.slice(-200))}`);
    }
  };

  for (const step of steps) {
    const after = step.after;

    if (after !== null) {
      await waitFor(
        `the console of ${name} to show ${after}`,
        () => {
          checkShown(after);
        },
        {
          intervalMs: 50,
          timeoutMs: 30_000,
        },
      );
    }

    proc.terminal?.write(`${step.line}\n`);
  }

  const exitCode = await proc.exited;

  proc.terminal?.close();

  return { exitCode, output: output.replaceAll('\r', '') };
}
