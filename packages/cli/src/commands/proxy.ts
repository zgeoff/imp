import { defineCommand } from '../define-command';
import { listReverseSpecs } from '../parse-reverse';
import { runProxy } from '../proxy-client';
import { nameArg } from './common-args';

export const proxyCommand = defineCommand({
  meta: {
    name: 'proxy',
    description:
      'Forward local ports to ports in an imp, waking it on connect (imp proxy <name> 5432 3001:3000), or with --reverse, a socket or port in the imp to this machine',
  },
  args: {
    name: nameArg,
    ports: {
      type: 'positional',
      description: 'port, or local:remote; a local 0 takes any free port',
      required: false,
    },
    reverse: {
      type: 'string',
      description:
        'GUEST:LOCAL, each an absolute socket path or a port, to relay clients in the imp to this machine; repeatable. The first listen wakes the imp. After a sleep the forward waits for something else to wake the imp, never waking it, then listens again; if its listener ended while the imp stayed awake, it listens again after 30 s',
    },
  },
  run: (context) =>
    runProxy({
      host: context.host,
      name: context.args.name,
      specs: context.args._.slice(1),
      reverse: listReverseSpecs(context.rawArgs),
    }),
});
