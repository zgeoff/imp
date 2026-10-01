import { defineCommand } from 'citty';
import { formatImps } from '../format-output';
import { parseDuration } from '../parse-duration';
import { runAction } from '../run-action';

const nameArg = { type: 'positional', description: 'imp name', required: true } as const;

export const newCommand = defineCommand({
  meta: { name: 'new', description: 'Create an imp and boot it' },
  args: {
    name: {
      type: 'positional',
      description: 'imp name (generated when left out)',
      required: false,
    },
    image: { type: 'string', description: 'image name' },
    vcpus: { type: 'string', description: 'vCPU count' },
    memory: { type: 'string', description: 'memory in MiB' },
  },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.create({
        ...(context.args.name !== undefined && { name: context.args.name }),
        ...(context.args.image !== undefined && { image: context.args.image }),
        ...(context.args.vcpus !== undefined && { vcpus: Number(context.args.vcpus) }),
        ...(context.args.memory !== undefined && { memoryMib: Number(context.args.memory) }),
      });

      console.log(formatImps([imp]));
    }),
});

export const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List imps' },
  run: () =>
    runAction(async (client) => {
      const imps = await client.imps.list();

      console.log(formatImps(imps));
    }),
});

export const rmCommand = defineCommand({
  meta: { name: 'rm', description: 'Destroy an imp and its disk and checkpoints' },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      await client.imps.destroy({ name: context.args.name });
    }),
});

export const sleepCommand = defineCommand({
  meta: { name: 'sleep', description: 'Snapshot an imp to disk and free its RAM' },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.sleep({ name: context.args.name });

      console.log(formatImps([imp]));
    }),
});

export const wakeCommand = defineCommand({
  meta: { name: 'wake', description: 'Resume a sleeping or stopped imp' },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.wake({ name: context.args.name });

      console.log(formatImps([imp]));
    }),
});

export const holdCommand = defineCommand({
  meta: { name: 'hold', description: 'Keep an imp awake for a while (0 releases)' },
  args: {
    name: nameArg,
    duration: { type: 'positional', description: 'e.g. 90s, 15m, 2h', required: true },
  },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.hold({
        name: context.args.name,
        seconds: parseDuration(context.args.duration),
      });

      console.log(`${imp.name} held until ${imp.holdUntil?.toISOString() ?? 'released'}`);
    }),
});

export const urlCommand = defineCommand({
  meta: { name: 'url', description: "Print an imp's URLs" },
  args: { name: nameArg },
  run: (context) =>
    runAction(async (client) => {
      const urls = await client.imps.url({ name: context.args.name });

      console.log(urls.local);

      if (urls.tailnet !== null) {
        console.log(urls.tailnet);
      }
    }),
});

export const forkCommand = defineCommand({
  meta: { name: 'fork', description: "Create an imp from another imp's disk or checkpoint" },
  args: {
    source: { type: 'positional', description: 'imp to fork', required: true },
    name: { type: 'positional', description: 'name of the new imp', required: true },
    checkpoint: { type: 'string', description: 'checkpoint id or label to fork from' },
  },
  run: (context) =>
    runAction(async (client) => {
      const imp = await client.imps.fork({
        source: context.args.source,
        name: context.args.name,
        ...(context.args.checkpoint !== undefined && { checkpoint: context.args.checkpoint }),
      });

      console.log(formatImps([imp]));
    }),
});

export const execCommand = defineCommand({
  meta: { name: 'exec', description: 'Run a command in an imp (imp exec <name> -- cmd args)' },
  args: { name: nameArg },
  run: () => runAction(() => Promise.reject(new Error('exec is not implemented yet'))),
});

export const consoleCommand = defineCommand({
  meta: { name: 'console', description: 'Open an interactive shell in an imp' },
  args: { name: nameArg },
  run: () => runAction(() => Promise.reject(new Error('console is not implemented yet'))),
});
