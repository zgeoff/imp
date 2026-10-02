import { isAbsolute } from 'node:path';
import type { Image } from '@imp/api';
import type { ImpClient } from '../create-imp-client';
import { defineCommand } from '../define-command';
import { formatImages, formatOutput } from '../format-output';
import { runImageBuild } from '../image/run-image-build';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg } from './common-args';

const addCommand = defineCommand({
  meta: { name: 'add', description: 'Import an image the host docker has or can pull' },
  args: {
    ref: { type: 'positional', description: 'docker image ref', required: true },
    name: { type: 'string', description: 'imp image name (defaults from the ref)' },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const image = await client.images.add({
        ref: context.args.ref,
        ...(context.args.name !== undefined && { name: context.args.name }),
      });

      console.log(formatOutput(image, context.args.json, (one) => formatImages([one])));
    }),
});

// The context is packed here and uploaded, honoring its .dockerignore;
// --on-host names a directory on the impd host instead, which never leaves it
const buildCommand = defineCommand({
  meta: { name: 'build', description: 'docker build a directory into an imp image' },
  args: {
    dir: { type: 'positional', description: 'build context directory', required: true },
    name: { type: 'string', description: 'imp image name', required: true },
    file: { type: 'string', description: 'Dockerfile path inside the context' },
    'on-host': {
      type: 'boolean',
      description: 'the directory is an absolute path on the impd host: nothing is uploaded',
    },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const image = await buildImage(client, {
        dir: context.args.dir,
        name: context.args.name,
        dockerfile: context.args.file,
        onHost: context.args['on-host'] === true,
      });

      console.log(formatOutput(image, context.args.json, (one) => formatImages([one])));
    }),
});

interface BuildArgs {
  readonly dir: string;
  readonly name: string;
  readonly dockerfile: string | undefined;
  readonly onHost: boolean;
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

  return client.images.build({
    contextDir: args.dir,
    name: args.name,
    ...(args.dockerfile !== undefined && { dockerfile: args.dockerfile }),
  });
}

const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List images' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const images = await client.images.list();

      console.log(formatOutput(images, context.args.json, formatImages));
    }),
});

const rmCommand = defineCommand({
  meta: { name: 'rm', description: 'Remove an image no imp uses' },
  args: { name: { type: 'positional', description: 'image name', required: true } },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.images.delete({ name: context.args.name });
    }),
});

export const imageCommand = defineCommand({
  meta: { name: 'image', description: 'Manage images' },
  subCommands: { add: addCommand, build: buildCommand, ls: lsCommand, rm: rmCommand },
});

// `imp template`: the images API with an imp as the source
// (docs/guides/templates.md)
const templateCreateCommand = defineCommand({
  meta: { name: 'create', description: "Make a template from an imp's disk" },
  args: {
    imp: { type: 'positional', description: 'imp to copy', required: true },
    name: {
      type: 'positional',
      description: 'template name; an existing template moves to the new disk',
      required: true,
    },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const image = await client.images.add({ imp: context.args.imp, name: context.args.name });

      console.log(formatOutput(image, context.args.json, (one) => formatImages([one])));
    }),
});

const templateLsCommand = defineCommand({
  meta: { name: 'ls', description: 'List templates' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const images = await client.images.list();

      const templates = images.filter((image) => image.source === 'imp');

      console.log(formatOutput(templates, context.args.json, formatImages));
    }),
});

const templateRmCommand = defineCommand({
  meta: { name: 'rm', description: 'Remove a template no imp uses' },
  args: { name: { type: 'positional', description: 'template name', required: true } },
  run: (context) =>
    runAction(context.host, async (client) => {
      const images = await client.images.list();

      const image = images.find((one) => one.name === context.args.name);

      if (image !== undefined && image.source !== 'imp') {
        throw new UsageError(
          `${context.args.name} is a docker image, not a template: use imp image rm`,
        );
      }

      await client.images.delete({ name: context.args.name });
    }),
});

export const templateCommand = defineCommand({
  meta: { name: 'template', description: "Manage templates: images made from an imp's disk" },
  subCommands: { create: templateCreateCommand, ls: templateLsCommand, rm: templateRmCommand },
});
