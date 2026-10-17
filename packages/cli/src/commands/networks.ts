import { jsonArg, nameArg } from '../args/common-args';
import { defineCommand, defineGroup } from '../cli/define-command';
import { runAction } from '../cli/run-action';
import { formatNetworks, formatOutput } from '../output/format-output';

const networkArg = { type: 'positional', description: 'network name', required: true } as const;

const createCommand = defineCommand({
  name: 'create',
  description: 'Create a private network for imps',
  args: { network: networkArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const network = await client.networks.create({ name: ctx.values.network });

      ctx.extensions.impz.io.print(
        formatOutput(network, ctx.values.json, (one) => formatNetworks([one])),
      );
    }),
});

const lsCommand = defineCommand({
  name: 'ls',
  description: 'List networks and the imps on each',
  args: { json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const networks = await client.networks.list();

      ctx.extensions.impz.io.print(formatOutput(networks, ctx.values.json, formatNetworks));
    }),
});

const rmCommand = defineCommand({
  name: 'rm',
  description: "Delete a network; its imps' connections to each other end",
  args: { network: networkArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await client.networks.delete({ name: ctx.values.network });
    }),
});

const joinCommand = defineCommand({
  name: 'join',
  description: "Put an imp on a network: it reaches the network's other imps, and they it",
  args: { network: networkArg, name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const network = await client.networks.join({
        network: ctx.values.network,
        name: ctx.values.name,
      });

      // on stderr, so --json stays one document
      if (network.warning !== null) {
        ctx.extensions.impz.io.printError(`warning: ${network.warning}`);
      }

      ctx.extensions.impz.io.print(
        formatOutput(network, ctx.values.json, (one) => formatNetworks([one])),
      );
    }),
});

const leaveCommand = defineCommand({
  name: 'leave',
  description: "Take an imp off a network; its connections to the network's imps end",
  args: { network: networkArg, name: nameArg, json: jsonArg },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const network = await client.networks.leave({
        network: ctx.values.network,
        name: ctx.values.name,
      });

      ctx.extensions.impz.io.print(
        formatOutput(network, ctx.values.json, (one) => formatNetworks([one])),
      );
    }),
});

export const netCommand = defineGroup({
  name: 'net',
  description: 'Manage private networks between imps',
  subCommands: {
    create: createCommand,
    ls: lsCommand,
    rm: rmCommand,
    join: joinCommand,
    leave: leaveCommand,
  },
});
