import { defineCommand } from '../define-command';
import { formatGc, formatOutput } from '../format-output';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg } from './common-args';

export const gcCommand = defineCommand({
  name: 'gc',
  description: 'Remove what a crash left that nothing names, and list the orphans it keeps',
  args: {
    'dry-run': { type: 'boolean', description: 'list what would go, and remove nothing' },
    orphans: {
      type: 'boolean',
      description: 'also retire the disks and images no row names, with their snapshots',
    },
    'secret-files': {
      type: 'boolean',
      description:
        'with --orphans, also delete the secret values impd kept aside; recover any you need first',
    },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const isRemoveSecretFiles = ctx.values['secret-files'] === true;

      if (isRemoveSecretFiles && ctx.values.orphans !== true) {
        throw new UsageError('--secret-files goes with --orphans');
      }

      // an impd older than secretFilesGc drops both, and lists and deletes none
      const result = await client.system.gc({
        dryRun: ctx.values['dry-run'] === true,
        orphans: ctx.values.orphans === true,
        secretFiles: true,
        removeSecretFiles: isRemoveSecretFiles,
      });

      ctx.extensions.impz.io.print(formatOutput(result, ctx.values.json, formatGc));
    }),
});
