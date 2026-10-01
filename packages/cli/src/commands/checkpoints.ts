import { defineCommand } from 'citty';
import { formatCheckpoints, formatImps } from '../format-output';
import { runAction } from '../run-action';

const nameArg = { type: 'positional', description: 'imp name', required: true } as const;

export const checkpointCommand = defineCommand({
  meta: { name: 'checkpoint', description: "Checkpoint an imp's disk" },
  args: {
    name: nameArg,
    label: { type: 'positional', description: 'label for the checkpoint', required: false },
  },
  run: (context) =>
    runAction(async (client) => {
      const checkpoint = await client.checkpoints.create({
        name: context.args.name,
        ...(context.args.label !== undefined && { label: context.args.label }),
      });

      console.log(formatCheckpoints([checkpoint]));
    }),
});

export const checkpointsCommand = defineCommand({
  meta: { name: 'checkpoints', description: "List an imp's checkpoints, newest first" },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      const checkpoints = await client.checkpoints.list({ name: context.args.name });

      console.log(formatCheckpoints(checkpoints));
    }),
});

export const restoreCommand = defineCommand({
  meta: { name: 'restore', description: 'Roll an imp back to a checkpoint and boot it' },
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
