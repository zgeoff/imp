import { defineCommand } from '../define-command';
import { formatCheckpoints, formatImp, formatOutput } from '../format-output';
import { runAction } from '../run-action';
import { jsonArg, nameArg } from './common-args';

// `imp checkpoint rm <name> <checkpoint>` shares the command with
// `imp checkpoint <name> [label]`: citty cannot mix subcommands with
// positionals, so a first positional `rm` always means a delete.
export const checkpointCommand = defineCommand({
  meta: {
    name: 'checkpoint',
    description: "Checkpoint an imp's disk (imp checkpoint rm <name> <checkpoint> deletes one)",
  },
  args: {
    name: nameArg,
    label: { type: 'positional', description: 'label for the checkpoint', required: false },
    json: jsonArg,
  },
  run: (context) =>
    runAction(async (client) => {
      const positionals = context.args._;

      if (positionals[0] === 'rm') {
        const [, name, checkpoint] = positionals;

        if (positionals.length !== 3 || name === undefined || checkpoint === undefined) {
          throw new Error('usage: imp checkpoint rm <name> <checkpoint>');
        }

        await client.checkpoints.delete({ name, checkpoint });

        return;
      }

      const checkpoint = await client.checkpoints.create({
        name: context.args.name,
        ...(context.args.label !== undefined && { label: context.args.label }),
      });

      console.log(formatOutput(checkpoint, context.args.json, (one) => formatCheckpoints([one])));
    }),
});

export const checkpointsCommand = defineCommand({
  meta: { name: 'checkpoints', description: "List an imp's checkpoints, newest first" },
  args: { name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(async (client) => {
      const checkpoints = await client.checkpoints.list({ name: context.args.name });

      console.log(formatOutput(checkpoints, context.args.json, formatCheckpoints));
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
    json: jsonArg,
  },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.checkpoints.restore({
        name: context.args.name,
        checkpoint: context.args.checkpoint,
      });

      console.log(formatOutput(imp, context.args.json, formatImp));
    }),
});
