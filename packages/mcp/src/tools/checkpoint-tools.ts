import * as z from 'zod';
import { defineTool } from './define-tool';
import type { Tool } from './define-tool';
import { ImpNameInput } from './imp-tools';

const CheckpointRefInput = z
  .string()
  .min(1)
  .describe('A checkpoint id or label, from imp_checkpoint_list');

export const CHECKPOINT_TOOLS: readonly Tool[] = [
  defineTool({
    name: 'imp_checkpoint',
    description:
      "Save the imp's disk as a checkpoint, in about 100 ms, without stopping it. Take one before a risky change; imp_restore goes back to it and imp_fork starts a new imp from it.",
    input: z.strictObject({
      name: ImpNameInput,
      label: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('A label to find the checkpoint by, such as before-migration'),
    }),
    annotations: {
      title: 'Checkpoint an imp',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    run: async (input, context) => {
      context.guard.require(input.name);

      const checkpoint = await context.client.checkpoints.create({
        name: input.name,
        ...(input.label !== undefined && { label: input.label }),
      });

      return { data: { checkpoint } };
    },
  }),
  defineTool({
    name: 'imp_checkpoint_list',
    description: "List the imp's checkpoints: id, label, time and size.",
    input: z.strictObject({ name: ImpNameInput }),
    annotations: { title: 'List checkpoints', readOnlyHint: true, openWorldHint: false },
    run: async (input, context) => {
      context.guard.require(input.name);

      const checkpoints = await context.client.checkpoints.list({ name: input.name });

      return { data: { checkpoints } };
    },
  }),
  defineTool({
    name: 'imp_restore',
    cancellable: false,
    description:
      "Put the imp's disk back to a checkpoint. Everything written since the checkpoint is lost, and so is the memory: an awake imp boots fresh, a sleeping or stopped one boots on its next use. A cancel does not stop the restore, and its result still comes back.",
    input: z.strictObject({ name: ImpNameInput, checkpoint: CheckpointRefInput }),
    annotations: {
      title: 'Restore a checkpoint',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    run: async (input, context) => {
      context.guard.require(input.name);

      const imp = await context.client.checkpoints.restore(input);

      return { data: { imp } };
    },
  }),
  defineTool({
    name: 'imp_checkpoint_delete',
    description: "Delete one of the imp's checkpoints for good. The imp itself is not touched.",
    input: z.strictObject({ name: ImpNameInput, checkpoint: CheckpointRefInput }),
    annotations: {
      title: 'Delete a checkpoint',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    run: async (input, context) => {
      context.guard.require(input.name);

      await context.client.checkpoints.delete(input);

      return { data: { deleted: input.checkpoint } };
    },
  }),
];
