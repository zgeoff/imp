import { isAbsolute } from 'node:path';
import { defineCommand } from '../define-command';
import { formatImages, formatOutput } from '../format-output';
import { runAction } from '../run-action';
import { jsonArg } from './common-args';

const addCommand = defineCommand({
  meta: { name: 'add', description: 'Import an image the host docker has or can pull' },
  args: {
    ref: { type: 'positional', description: 'docker image ref', required: true },
    name: { type: 'string', description: 'imp image name (defaults from the ref)' },
    json: jsonArg,
  },
  run: (context) =>
    runAction(async (client) => {
      const image = await client.images.add({
        ref: context.args.ref,
        ...(context.args.name !== undefined && { name: context.args.name }),
      });

      console.log(formatOutput(image, context.args.json, (one) => formatImages([one])));
    }),
});

// impd runs `docker build` on its own host, so the directory is a path
// there, not here: a relative path would name a directory this shell sees
const buildCommand = defineCommand({
  meta: {
    name: 'build',
    description: 'docker build a directory on the impd host into an imp image',
  },
  args: {
    dir: {
      type: 'positional',
      description: 'build context: an absolute path on the impd host',
      required: true,
    },
    name: { type: 'string', description: 'imp image name', required: true },
    file: { type: 'string', description: 'Dockerfile path inside the context' },
    json: jsonArg,
  },
  run: (context) =>
    runAction(async (client) => {
      if (!isAbsolute(context.args.dir)) {
        throw new Error(
          `the build context is a directory on the impd host: give its absolute path, not ${context.args.dir}`,
        );
      }

      const image = await client.images.build({
        contextDir: context.args.dir,
        name: context.args.name,
        ...(context.args.file !== undefined && { dockerfile: context.args.file }),
      });

      console.log(formatOutput(image, context.args.json, (one) => formatImages([one])));
    }),
});

const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List images' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(async (client) => {
      const images = await client.images.list();

      console.log(formatOutput(images, context.args.json, formatImages));
    }),
});

const rmCommand = defineCommand({
  meta: { name: 'rm', description: 'Remove an image no imp uses' },
  args: { name: { type: 'positional', description: 'image name', required: true } },
  run: (context) =>
    runAction(async (client) => {
      await client.images.delete({ name: context.args.name });
    }),
});

export const imageCommand = defineCommand({
  meta: { name: 'image', description: 'Manage images' },
  subCommands: { add: addCommand, build: buildCommand, ls: lsCommand, rm: rmCommand },
});
