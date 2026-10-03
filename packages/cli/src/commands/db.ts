import { defineCommand } from '../define-command';
import { formatOutput } from '../format-output';
import { requireFeature } from '../require-feature';
import { runAction } from '../run-action';
import { jsonArg } from './common-args';

const copyCommand = defineCommand({
  meta: {
    name: 'copy',
    description: "Copy impd's database, consistently and while it runs, under its data directory",
  },
  args: {
    name: {
      type: 'positional',
      description: 'the copy is <data>/db-copies/<name>.sqlite (default: imp-<UTC time>)',
      required: false,
    },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      await requireFeature(client, 'databaseCopy', 'not know the call');

      const copy = await client.system.copyDatabase({
        ...(context.args.name !== undefined && { name: context.args.name }),
      });

      console.log(
        formatOutput(copy, context.args.json, (made) =>
          [
            made.path,
            `${String(made.sizeBytes)} bytes, schema at migration ${made.lastMigration}, from impd ${made.impVersion}`,
            `integrity: ${made.integrity}`,
          ].join('\n'),
        ),
      );
    }),
});

export const dbCommand = defineCommand({
  meta: { name: 'db', description: "impd's database" },
  subCommands: { copy: copyCommand },
});
