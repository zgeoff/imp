import { join } from 'node:path';
import { readImpEnv } from './imp-cli';
import { REPO_ROOT } from './instance';

export interface ConsoleStep {
  readonly afterMs: number;
  readonly line: string;
}

// Runs `imp console NAME` on a pseudo-terminal, as a user at a terminal
// would, typing each line after its delay. Returns the exit code and what
// the terminal showed, without carriage returns.
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

  for (const step of steps) {
    await Bun.sleep(step.afterMs);

    proc.terminal?.write(`${step.line}\n`);
  }

  const exitCode = await proc.exited;

  proc.terminal?.close();

  return { exitCode, output: output.replaceAll('\r', '') };
}
