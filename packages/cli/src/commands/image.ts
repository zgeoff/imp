import { isAbsolute } from 'node:path';
import type { Image } from '@impz/api';
import { requireFeatures } from '@impz/client';
import { toProgressOutput } from '../command-io';
import type { ProgressOutput } from '../cp/copy-progress';
import type { ImpClient } from '../create-imp-client';
import { defineCommand, defineGroup } from '../define-command';
import { formatImageBuilds, formatImages, formatOutput } from '../format-output';
import { runImageBuild } from '../image/run-image-build';
import { runImageAdd, runOnHostBuild } from '../image/run-image-op';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg } from './common-args';

const addCommand = defineCommand({
  name: 'add',
  description: 'Import an image the host docker has or can pull',
  args: {
    ref: { type: 'positional', description: 'docker image ref', required: true },
    name: { type: 'string', description: 'imp image name (defaults from the ref)' },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const image = await runImageAdd(
        client,
        {
          ref: ctx.values.ref,
          ...(ctx.values.name !== undefined && { name: ctx.values.name }),
        },
        'impz image add',
        toProgressOutput(ctx.extensions.impz.io),
      );

      ctx.extensions.impz.io.print(
        formatOutput(image, ctx.values.json, (one) => formatImages([one])),
      );
    }),
});

// The context is packed here and uploaded, honoring its .dockerignore;
// --on-host names a directory on the impd host instead, which never leaves it
const buildCommand = defineCommand({
  name: 'build',
  description: 'Build a directory with its Dockerfile into an imp image',
  args: {
    dir: { type: 'positional', description: 'build context directory', required: true },
    name: { type: 'string', description: 'imp image name', required: true },
    file: { type: 'string', description: 'Dockerfile path inside the context' },
    'on-host': {
      type: 'boolean',
      description: 'the directory is an absolute path on the impd host: nothing is uploaded',
    },
    quiet: {
      type: 'boolean',
      short: 'q',
      description: 'print no progress and no build output, only the result or the error',
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const image = await buildImage(client, {
        dir: ctx.values.dir,
        name: ctx.values.name,
        dockerfile: ctx.values.file,
        onHost: ctx.values['on-host'] === true,
        quiet: ctx.values.quiet === true,
        output: toProgressOutput(ctx.extensions.impz.io),
      });

      ctx.extensions.impz.io.print(
        formatOutput(image, ctx.values.json, (one) => formatImages([one])),
      );
    }),
});

interface BuildArgs {
  readonly dir: string;
  readonly name: string;
  readonly dockerfile: string | undefined;
  readonly onHost: boolean;
  readonly quiet: boolean;
  readonly output: ProgressOutput;
}

function buildImage(client: ImpClient, args: Readonly<BuildArgs>): Promise<Image> {
  if (!args.onHost) {
    return runImageBuild(client, args);
  }

  // impd runs docker build there: a relative path would name a directory
  // this shell sees
  if (!isAbsolute(args.dir)) {
    throw new UsageError(`--on-host takes an absolute path on the impd host, not ${args.dir}`);
  }

  return runOnHostBuild(
    client,
    {
      contextDir: args.dir,
      name: args.name,
      ...(args.dockerfile !== undefined && { dockerfile: args.dockerfile }),
    },
    args.output,
    args.quiet,
  );
}

// the builds impd runs now, from any client or shell
const buildsCommand = defineCommand({
  name: 'builds',
  description: 'List the image builds running now',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await requireFeatures(client, { imageBuilds: 'answer images.builds with not found' });

      const builds = await client.images.builds();

      ctx.extensions.impz.io.print(
        formatOutput(builds, ctx.values.json, (all) => formatImageBuilds(all, Date.now())),
      );
    }),
});

const lsCommand = defineCommand({
  name: 'ls',
  description: 'List images',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const images = await client.images.list();

      ctx.extensions.impz.io.print(formatOutput(images, ctx.values.json, formatImages));
    }),
});

const rmCommand = defineCommand({
  name: 'rm',
  description: 'Remove an image no imp uses',
  args: { name: { type: 'positional', description: 'image name', required: true } },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.images.delete({ name: ctx.values.name });
    }),
});

export const imageCommand = defineGroup({
  name: 'image',
  description: 'Manage images',
  subCommands: {
    add: addCommand,
    build: buildCommand,
    builds: buildsCommand,
    ls: lsCommand,
    rm: rmCommand,
  },
});

// `impz template`: the images API with an imp as the source
// (docs/guides/templates.md)
const templateCreateCommand = defineCommand({
  name: 'create',
  description: "Make a template from an imp's disk",
  args: {
    imp: { type: 'positional', description: 'imp to copy', required: true },
    name: {
      type: 'positional',
      description: 'template name; an existing template moves to the new disk',
      required: true,
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const image = await runImageAdd(
        client,
        { imp: ctx.values.imp, name: ctx.values.name },
        'impz template create',
        toProgressOutput(ctx.extensions.impz.io),
      );

      ctx.extensions.impz.io.print(
        formatOutput(image, ctx.values.json, (one) => formatImages([one])),
      );
    }),
});

const templateLsCommand = defineCommand({
  name: 'ls',
  description: 'List templates',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const images = await client.images.list();

      const templates = images.filter((image) => image.source === 'imp');

      ctx.extensions.impz.io.print(formatOutput(templates, ctx.values.json, formatImages));
    }),
});

const templateRmCommand = defineCommand({
  name: 'rm',
  description: 'Remove a template no imp uses',
  args: { name: { type: 'positional', description: 'template name', required: true } },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const images = await client.images.list();

      const image = images.find((one) => one.name === ctx.values.name);

      if (image !== undefined && image.source !== 'imp') {
        throw new UsageError(
          `${ctx.values.name} is a docker image, not a template: use impz image rm`,
        );
      }

      await client.images.delete({ name: ctx.values.name });
    }),
});

export const templateCommand = defineGroup({
  name: 'template',
  description: "Manage templates: images made from an imp's disk",
  subCommands: { create: templateCreateCommand, ls: templateLsCommand, rm: templateRmCommand },
});
