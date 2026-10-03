import { NameSchema } from '@imp/api';
import * as z from 'zod';
import { defineTool } from './define-tool';
import type { Tool } from './define-tool';

export const ImpNameInput = NameSchema.describe('The imp name, from imp_list');
const NameOnly = z.strictObject({ name: ImpNameInput });

// Never the host: no tool takes a host path (images.build's contextDir is
// one), and every guest path stays in the guest.
export const IMP_TOOLS: readonly Tool[] = [
  defineTool({
    name: 'imp_list',
    scope: 'read',
    description:
      'List the imps this server may touch: name, state (running, sleeping, stopped, error), image, memory and URL. A sleeping or stopped imp wakes or boots by itself on the next exec, file or HTTP request.',
    input: z.strictObject({}),
    annotations: { title: 'List imps', readOnlyHint: true, openWorldHint: false },
    run: async (_input, context) => {
      const imps = await context.client.imps.list();

      return { data: { imps: imps.filter((imp) => context.guard.isAllowed(imp.name)) } };
    },
  }),
  defineTool({
    name: 'imp_create',
    scope: 'manage',
    cancellable: false,
    description:
      'Create an imp, a persistent Linux microVM, and boot it. Its disk survives sleeps and restarts until imp_destroy. Without a name, the server picks one inside its guard. Returns the imp. A cancel does not stop the create, and its result still comes back.',
    input: z.strictObject({
      name: NameSchema.optional().describe(
        "The new imp's name: a lowercase letter, then up to 30 lowercase letters, digits or hyphens. Omit to have one picked.",
      ),
      image: NameSchema.optional().describe(
        "The image to boot, from imp_image_list; impd's default when omitted",
      ),
      vcpus: z
        .int()
        .min(1)
        .max(32)
        .optional()
        .describe("Virtual CPUs; impd's default when omitted"),
      memoryMib: z
        .int()
        .min(128)
        .optional()
        .describe("Guest memory in MiB; impd's default when omitted"),
      httpPort: z
        .int()
        .min(1)
        .max(65_535)
        .optional()
        .describe("The guest port the imp's URL forwards HTTP to (default 8080)"),
    }),
    annotations: {
      title: 'Create an imp',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    run: async (input, context) => {
      const name = input.name ?? context.guard.pickNewName();

      if (name !== null) {
        context.guard.require(name);
      }

      const imp = await context.client.imps.create({
        ...input,
        ...(name !== null && { name }),
      });

      return { data: { imp } };
    },
  }),
  defineTool({
    name: 'imp_destroy',
    scope: 'manage',
    description:
      'Destroy an imp: its VM, its disk and its checkpoints are deleted for good. Forks of it are separate imps and stay.',
    input: NameOnly,
    annotations: {
      title: 'Destroy an imp',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    run: async (input, context) => {
      context.guard.require(input.name);

      await context.client.imps.destroy({ name: input.name });

      return { data: { destroyed: input.name } };
    },
  }),
  defineTool({
    name: 'imp_sleep',
    scope: 'exec',
    description:
      'Put a running imp to sleep: its memory goes to disk and it frees its RAM. The next exec, file or HTTP request wakes it where it left off, in about 100 ms.',
    input: NameOnly,
    annotations: {
      title: 'Sleep an imp',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async (input, context) => {
      context.guard.require(input.name);

      const imp = await context.client.imps.sleep({ name: input.name });

      return { data: { imp } };
    },
  }),
  defineTool({
    name: 'imp_url',
    scope: 'read',
    description:
      "The imp's HTTP URLs: `local` on the imp host, `https` when impd has a domain, and `tailnet` when impd is on a tailnet. A request wakes a sleeping imp and goes to its httpPort.",
    input: NameOnly,
    annotations: { title: 'Get URLs', readOnlyHint: true, openWorldHint: false },
    run: async (input, context) => {
      context.guard.require(input.name);

      const urls = await context.client.imps.url({ name: input.name });

      return { data: urls };
    },
  }),
  defineTool({
    name: 'imp_fork',
    scope: 'manage',
    cancellable: false,
    description:
      "Create a new imp from the disk of another, now or as it was at one of its checkpoints. The fork boots fresh: it has the disk, not the running processes. Use it to try two approaches side by side. A token limited to some imps gives the fork only the source's secret grants it could make itself; grantsNotCopied names each grant the fork did not get, and grantsError says why it got none. A cancel does not stop the fork, and its result still comes back.",
    input: z.strictObject({
      source: NameSchema.describe('The imp to fork, from imp_list'),
      name: NameSchema.optional().describe("The fork's name; omit to have one picked"),
      checkpoint: z
        .string()
        .min(1)
        .optional()
        .describe(
          "A checkpoint id or label of the source, from imp_checkpoint_list; the source's disk now when omitted",
        ),
    }),
    annotations: {
      title: 'Fork an imp',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    run: async (input, context) => {
      context.guard.require(input.source);

      const name = input.name ?? context.guard.pickNewName();

      if (name === null) {
        throw new Error('give the fork a name');
      }

      context.guard.require(name);

      const { grantsNotCopied, grantsError, ...imp } = await context.client.imps.fork({
        source: input.source,
        name,
        ...(input.checkpoint !== undefined && { checkpoint: input.checkpoint }),
      });

      // beside the imp, not in it, so an agent reads them as the fork's
      // outcome; left out, not empty, from an impd before the report, which
      // does not say what it skipped
      return {
        data: {
          imp,
          ...(grantsNotCopied !== undefined && { grantsNotCopied }),
          ...(grantsError !== undefined && { grantsError }),
        },
      };
    },
  }),
  defineTool({
    name: 'imp_image_list',
    scope: 'read',
    description: 'List the images an imp can boot from, for imp_create.',
    input: z.strictObject({}),
    annotations: { title: 'List images', readOnlyHint: true, openWorldHint: false },
    run: async (_input, context) => {
      const images = await context.client.images.list();

      return { data: { images } };
    },
  }),
];
