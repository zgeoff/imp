import { runCp } from '../cp/run-cp';
import { defineCommand } from '../define-command';

export const cpCommand = defineCommand({
  meta: {
    name: 'cp',
    description:
      'Copy a file or directory into or out of an imp (imp cp ./dir box:/srv/dir, imp cp box:/var/log/x .)',
  },
  args: {
    source: {
      type: 'positional',
      description: 'a local path, or NAME:PATH in an imp',
      required: true,
    },
    target: {
      type: 'positional',
      description: 'a local path, or NAME:PATH in an imp',
      required: true,
    },
    owner: {
      type: 'string',
      description:
        'owner of what a copy into an imp makes: user, uid, user:group (default: the owner of the directory it lands in)',
    },
  },
  run: (context) =>
    runCp({
      host: context.host,
      source: context.args.source,
      target: context.args.target,
      ...(context.args.owner !== undefined && { owner: context.args.owner }),
    }),
});
