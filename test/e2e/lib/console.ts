import { join } from 'node:path';
import { readImpEnv } from './imp-cli';
import { REPO_ROOT } from './instance';

export interface ConsoleStep {
  readonly afterMs: number;
  readonly line: string;
}

// Runs `imp console NAME` on a pseudo-terminal (util-linux `script`), as a
// user at a terminal would, typing each line after its delay. Returns the
// exit code and what the terminal showed, without carriage returns.
export async function runConsole(
  name: string,
  steps: readonly ConsoleStep[],
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const command = `${join(REPO_ROOT, 'scripts', 'imp')} console ${name}`;

  const impEnv = await readImpEnv();

  const proc = Bun.spawn(['script', '-qec', command, '/dev/null'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...impEnv, SHELL: '/bin/bash' },
  });

  const output = new Response(proc.stdout).text();

  for (const step of steps) {
    await Bun.sleep(step.afterMs);
    await proc.stdin.write(`${step.line}\n`);
    await proc.stdin.flush();
  }

  await proc.stdin.end();

  const exitCode = await proc.exited;
  const shown = await output;

  return { exitCode, output: shown.replaceAll('\r', '') };
}
