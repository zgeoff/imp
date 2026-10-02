import { defineCommand } from '../define-command';
import { formatGc, formatOutput } from '../format-output';
import { runAction } from '../run-action';
import { jsonArg } from './common-args';

export const gcCommand = defineCommand({
  meta: {
    name: 'gc',
    description: 'Remove disks, checkpoints, images and snapshots that nothing names',
  },
  args: {
    'dry-run': { type: 'boolean', description: 'list what would go, and remove nothing' },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const result = await client.system.gc({ dryRun: context.args['dry-run'] === true });

      console.log(formatOutput(result, context.args.json, formatGc));
    }),
});
