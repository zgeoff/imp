import { requireFeatures } from '@impz/client';
import { defineCommand, defineGroup } from '../define-command';
import { formatOutput } from '../format-output';
import { runAction } from '../run-action';
import { jsonArg } from './common-args';

const copyCommand = defineCommand({
  name: 'copy',
  description: "Copy impd's database, consistently and while it runs, under its data directory",
  args: {
    name: {
      type: 'positional',
      description: 'the copy is <data>/db-copies/<name>.sqlite (default: imp-<UTC time>)',
      required: false,
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      await requireFeatures(client, { databaseCopy: 'not know the call' });

      const copy = await client.system.copyDatabase({
        ...(ctx.values.name !== undefined && { name: ctx.values.name }),
      });

      ctx.extensions.impz.io.print(
        formatOutput(copy, ctx.values.json, (made) =>
          [
            made.path,
            `${String(made.sizeBytes)} bytes, schema at migration ${made.lastMigration}, from impd ${made.impVersion}`,
            `integrity: ${made.integrity}`,
          ].join('\n'),
        ),
      );
    }),
});

export const dbCommand = defineGroup({
  name: 'db',
  description: "impd's database",
  subCommands: { copy: copyCommand },
});
