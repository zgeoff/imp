import { toProgressOutput } from '../cli/command-io';
import { defineCommand } from '../cli/define-command';
import { runCp } from '../cp/run-cp';

export const cpCommand = defineCommand({
  name: 'cp',
  description:
    'Copy a file or directory into or out of an imp (impz cp ./dir box:/srv/dir, impz cp box:/var/log/x .)',
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
  run: (ctx) =>
    runCp({
      host: ctx.extensions.impz.host,
      env: ctx.extensions.impz.io.env,
      warn: ctx.extensions.impz.io.printError,
      output: toProgressOutput(ctx.extensions.impz.io),
      source: ctx.values.source,
      target: ctx.values.target,
      ...(ctx.values.owner !== undefined && { owner: ctx.values.owner }),
    }),
});
