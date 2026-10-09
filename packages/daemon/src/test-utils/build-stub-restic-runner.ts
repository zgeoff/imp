import type { CommandResult } from '../process/run-command';

// The process runner createRestic hands each restic command to: it answers
// with the queued results in order, then with a clean exit and no output, and
// records each argv (joined by spaces) and env it was given.
export function buildStubResticRunner(results: readonly CommandResult[] = []) {
  const argvs: string[] = [];
  const envs: Readonly<Record<string, string>>[] = [];
  const queued = [...results];

  const run = (
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Promise<CommandResult> => {
    argvs.push(argv.join(' '));
    envs.push(env);

    return Promise.resolve(queued.shift() ?? { exitCode: 0, stdout: '', stderr: '' });
  };

  return { run, argvs, envs };
}
