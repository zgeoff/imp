import { jsonArg, nameArg } from '../args/common-args';
import { defineCommand } from '../cli/define-command';
import { dispatchVerb, listOperands } from '../cli/dispatch-verb';
import { UsageError } from '../cli/errors';
import { runAction } from '../cli/run-action';
import { formatCheckpoints, formatImp, formatOutput } from '../output/format-output';

export const checkpointCommand = defineCommand({
  name: 'checkpoint',
  description: "Checkpoint an imp's disk (impz checkpoint rm <name> <checkpoint> deletes one)",
  args: {
    name: nameArg,
    label: { type: 'positional', description: 'label for the checkpoint', required: false },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, (client) =>
      dispatchVerb(
        listOperands(ctx),
        {
          rm: async (operands) => {
            const [name, checkpoint] = operands;

            if (operands.length !== 2 || name === undefined || checkpoint === undefined) {
              throw new UsageError('usage: impz checkpoint rm <name> <checkpoint>');
            }

            await client.checkpoints.delete({ name, checkpoint });
          },
        },
        async () => {
          const checkpoint = await client.checkpoints.create({
            name: ctx.values.name,
            ...(ctx.values.label !== undefined && { label: ctx.values.label }),
          });

          ctx.extensions.impz.io.print(
            formatOutput(checkpoint, ctx.values.json, (one) => formatCheckpoints([one])),
          );
        },
      ),
    ),
});

export const checkpointsCommand = defineCommand({
  name: 'checkpoints',
  description: "List an imp's checkpoints, newest first",
  args: { name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const checkpoints = await client.checkpoints.list({ name: ctx.values.name });

      ctx.extensions.impz.io.print(formatOutput(checkpoints, ctx.values.json, formatCheckpoints));
    }),
});

export const restoreCommand = defineCommand({
  name: 'restore',
  description: "Roll an imp's disk back to a checkpoint; an awake imp reboots",
  args: {
    name: nameArg,
    checkpoint: { type: 'positional', description: 'checkpoint id or label', required: true },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.checkpoints.restore({
        name: ctx.values.name,
        checkpoint: ctx.values.checkpoint,
      });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});
