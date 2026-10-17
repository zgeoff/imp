import type { CommandIO } from '../command-io';
import type { ImpClient } from '../create-imp-client';
import { defineCommand, defineGroup } from '../define-command';
import { formatNetworks, formatOutput } from '../format-output';
import { runAction } from '../run-action';
import { jsonArg, nameArg } from './common-args';

// what impd says of the imp's networks after a change that can mix open
// imps with box ones; on stderr, so --json stays one document
export async function printTrustWarnings(
  client: ImpClient,
  io: CommandIO,
  name: string,
): Promise<void> {
  const warnings = await client.networks.warnings({ name });

  for (const warning of warnings) {
    io.printError(`warning: ${warning}`);
  }
}

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
