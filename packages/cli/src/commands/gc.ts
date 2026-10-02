import { defineCommand } from '../define-command';
import { formatGc, formatOutput } from '../format-output';
import { runAction } from '../run-action';
import { jsonArg } from './common-args';

export const gcCommand = defineCommand({
  meta: {
    name: 'gc',
    description: 'Remove what a crash left that nothing names, and list the orphans it keeps',
  },
  args: {
    'dry-run': { type: 'boolean', description: 'list what would go, and remove nothing' },
    orphans: {
      type: 'boolean',
      description: 'also retire the disks and images no row names, with their snapshots',
    },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const result = await client.system.gc({
        dryRun: context.args['dry-run'] === true,
        orphans: context.args.orphans === true,
      });

      console.log(formatOutput(result, context.args.json, formatGc));
    }),
});
