import { requireFeatures } from '@impz/client';
import { jsonArg } from '../args/common-args';
import { defineCommand, defineGroup } from '../cli/define-command';
import { runAction } from '../cli/run-action';
import { formatOutput } from '../output/format-output';

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
