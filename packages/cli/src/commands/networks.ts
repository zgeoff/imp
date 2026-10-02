import { defineCommand } from '../define-command';
import { formatNetworks, formatOutput } from '../format-output';
import { runAction } from '../run-action';
import { jsonArg, nameArg } from './common-args';

const networkArg = { type: 'positional', description: 'network name', required: true } as const;

const createCommand = defineCommand({
  meta: { name: 'create', description: 'Create a private network for imps' },
  args: { network: networkArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const network = await client.networks.create({ name: context.args.network });

      console.log(formatOutput(network, context.args.json, (one) => formatNetworks([one])));
    }),
});

const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List networks and the imps on each' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const networks = await client.networks.list();

      console.log(formatOutput(networks, context.args.json, formatNetworks));
    }),
});

const rmCommand = defineCommand({
  meta: { name: 'rm', description: "Delete a network; its imps' connections to each other end" },
  args: { network: networkArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.networks.delete({ name: context.args.network });
    }),
});

const joinCommand = defineCommand({
  meta: {
    name: 'join',
    description: "Put an imp on a network: it reaches the network's other imps, and they it",
  },
  args: { network: networkArg, name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const network = await client.networks.join({
        network: context.args.network,
        name: context.args.name,
      });

      console.log(formatOutput(network, context.args.json, (one) => formatNetworks([one])));
    }),
});

const leaveCommand = defineCommand({
  meta: {
    name: 'leave',
    description: "Take an imp off a network; its connections to the network's imps end",
  },
  args: { network: networkArg, name: nameArg, json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const network = await client.networks.leave({
        network: context.args.network,
        name: context.args.name,
      });

      console.log(formatOutput(network, context.args.json, (one) => formatNetworks([one])));
    }),
});

export const netCommand = defineCommand({
  meta: { name: 'net', description: 'Manage private networks between imps' },
  subCommands: {
    create: createCommand,
    ls: lsCommand,
    rm: rmCommand,
    join: joinCommand,
    leave: leaveCommand,
  },
});
