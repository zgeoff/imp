import { choice, positional } from 'gunshi/combinators';
import { SHELLS, buildCompletionTree, renderCompletion } from '../completion';
import { defineCommand } from '../define-command';

export const completionCommand = defineCommand({
  name: 'completion',
  description: 'Print the shell completion script (bash, zsh or fish)',
  args: { shell: positional(choice(SHELLS, { description: 'bash, zsh or fish', required: true })) },
  run: async (ctx) => {
    const commandTree = await import('../command-tree');
    const tree = await buildCompletionTree(commandTree.mainCommand);

    ctx.extensions.impz.io.writeOut(renderCompletion(ctx.values.shell, tree));
  },
});
