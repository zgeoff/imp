import { defineCommand } from '../define-command';
import { runProxy } from '../proxy-client';
import { nameArg } from './common-args';

export const proxyCommand = defineCommand({
  meta: {
    name: 'proxy',
    description:
      'Forward local ports to ports in an imp, waking it on connect (imp proxy <name> 5432 3001:3000)',
  },
  args: {
    name: nameArg,
    ports: {
      type: 'positional',
      description: 'port, or local:remote; a local 0 takes any free port',
      required: true,
    },
  },
  run: (context) =>
    runProxy({ host: context.host, name: context.args.name, specs: context.args._.slice(1) }),
});
