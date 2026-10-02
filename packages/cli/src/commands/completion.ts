import { SHELLS, buildCompletionTree, renderCompletion } from '../completion';
import type { Shell } from '../completion';
import { defineCommand } from '../define-command';
import { printError } from '../run-action';
import { UsageError } from '../usage-error';

export const completionCommand = defineCommand({
  meta: {
    name: 'completion',
    description: 'Print the shell completion script (bash, zsh or fish)',
  },
  args: { shell: { type: 'positional', description: 'bash, zsh or fish', required: true } },
  run: async (context) => {
    try {
      const shell = parseShell(context.args.shell);

      const commandTree = await import('../command-tree');
      const tree = await buildCompletionTree(commandTree.mainCommand);

      process.stdout.write(renderCompletion(shell, tree));
    } catch (error) {
      printError(error);
    }
  },
});

function parseShell(value: string): Shell {
  const shell = SHELLS.find((name) => name === value);

  if (shell === undefined) {
    throw new UsageError(`no completion for ${value} (try ${SHELLS.join(', ')})`);
  }

  return shell;
}
