import { defineCommand } from '../define-command';
import { formatCheckpoints, formatImps, formatJson } from '../format-output';
import { runAction } from '../run-action';

const nameArg = { type: 'positional', description: 'imp name', required: true } as const;

// `imp checkpoint rm <name> <checkpoint>` shares the command with
// `imp checkpoint <name> [label]`: citty cannot mix subcommands with
// positionals, so three positionals led by `rm` mean a delete.
export const checkpointCommand = defineCommand({
  meta: {
    name: 'checkpoint',
    description: "Checkpoint an imp's disk (imp checkpoint rm <name> <checkpoint> deletes one)",
  },
  args: {
    name: nameArg,
    label: { type: 'positional', description: 'label for the checkpoint', required: false },
  },
  run: (context) =>
    runAction(async (client) => {
      const positionals = context.args._;

      if (positionals.length === 3 && positionals[0] === 'rm') {
        await client.checkpoints.delete({
          name: positionals[1] ?? '',
          checkpoint: positionals[2] ?? '',
        });

        return;
      }

      const checkpoint = await client.checkpoints.create({
        name: context.args.name,
        ...(context.args.label !== undefined && { label: context.args.label }),
      });

      console.log(formatCheckpoints([checkpoint]));
    }),
});

export const checkpointsCommand = defineCommand({
  meta: { name: 'checkpoints', description: "List an imp's checkpoints, newest first" },
  args: { name: nameArg, json: { type: 'boolean', description: 'print JSON' } },
  run: (context) =>
    runAction(async (client) => {
      const checkpoints = await client.checkpoints.list({ name: context.args.name });

      const output =
        context.args.json === true ? formatJson(checkpoints) : formatCheckpoints(checkpoints);

      console.log(output);
    }),
});

export const restoreCommand = defineCommand({
  meta: {
    name: 'restore',
    description: "Roll an imp's disk back to a checkpoint; an awake imp reboots",
  },
  args: {
    name: nameArg,
    checkpoint: { type: 'positional', description: 'checkpoint id or label', required: true },
  },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.checkpoints.restore({
        name: context.args.name,
        checkpoint: context.args.checkpoint,
      });

      console.log(formatImps([imp]));
    }),
});
