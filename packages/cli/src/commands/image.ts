import { resolve } from 'node:path';
import { defineCommand } from '../define-command';
import { formatImages } from '../format-output';
import { runAction } from '../run-action';

const addCommand = defineCommand({
  meta: { name: 'add', description: 'Import an image the host docker has or can pull' },
  args: {
    ref: { type: 'positional', description: 'docker image ref', required: true },
    name: { type: 'string', description: 'imp image name (defaults from the ref)' },
  },
  run: (context) =>
    runAction(async (client) => {
      const image = await client.images.add({
        ref: context.args.ref,
        ...(context.args.name !== undefined && { name: context.args.name }),
      });

      console.log(formatImages([image]));
    }),
});

const buildCommand = defineCommand({
  meta: { name: 'build', description: 'docker build a directory into an imp image' },
  args: {
    dir: { type: 'positional', description: 'build context directory', required: true },
    name: { type: 'string', description: 'imp image name', required: true },
    file: { type: 'string', description: 'Dockerfile path inside the context' },
  },
  run: (context) =>
    runAction(async (client) => {
      const image = await client.images.build({
        contextDir: resolve(context.args.dir),
        name: context.args.name,
        ...(context.args.file !== undefined && { dockerfile: context.args.file }),
      });

      console.log(formatImages([image]));
    }),
});

const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List images' },
  run: () =>
    runAction(async (client) => {
      const images = await client.images.list();

      console.log(formatImages(images));
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
