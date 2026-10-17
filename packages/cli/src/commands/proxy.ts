import { defineCommand } from '../define-command';
import { runProxy } from '../proxy-client';
import { nameArg } from './common-args';

export const proxyCommand = defineCommand({
  name: 'proxy',
  description:
    'Forward local ports to ports in an imp, waking it on connect (impz proxy <name> 5432 3001:3000), or with --reverse, a socket or port in the imp to this machine',
  args: {
    name: nameArg,
    ports: {
      type: 'positional',
      description: 'port, or local:remote; a local 0 takes any free port',
      multiple: true,
    },
    reverse: {
      type: 'string',
      multiple: true,
      description:
        'GUEST:LOCAL, each an absolute socket path or a port, to relay clients in the imp to this machine; repeatable. The first listen wakes the imp. After a sleep the forward waits for something else to wake the imp, never waking it, then listens again; if its listener ended while the imp stayed awake, it listens again after 30 s',
    },
  },
  run: (ctx) =>
    runProxy({
      host: ctx.extensions.impz.host,
      env: ctx.extensions.impz.io.env,
      warn: ctx.extensions.impz.io.printError,
      name: ctx.values.name,
      specs: ctx.values.ports ?? [],
      reverse: ctx.values.reverse ?? [],
    }),
});
