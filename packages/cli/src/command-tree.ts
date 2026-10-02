import { defineCommand } from 'citty';
import packageJson from '../package.json' with { type: 'json' };
import { checkpointCommand, checkpointsCommand, restoreCommand } from './commands/checkpoints';
import { hostCommand, hostsCommand, loginCommand } from './commands/hosts';
import { imageCommand } from './commands/image';
import {
  consoleCommand,
  execCommand,
  forkCommand,
  holdCommand,
  lsCommand,
  newCommand,
  rmCommand,
  sleepCommand,
  startCommand,
  stopCommand,
  urlCommand,
  wakeCommand,
} from './commands/imps';
import { infoCommand } from './commands/info';

// Every imp command. `completion` walks this tree to write its scripts, so
// it loads lazily: a static import would be a cycle.
export const mainCommand = defineCommand({
  meta: {
    name: 'imp',
    version: packageJson.version,
    description: 'Persistent Linux microVMs that sleep when idle and wake on request',
  },

  // main takes --host out before citty parses; declared here for --help
  args: { host: { type: 'string', description: 'saved host to call (see imp host ls)' } },
  subCommands: {
    new: newCommand,
    ls: lsCommand,
    rm: rmCommand,
    start: startCommand,
    stop: stopCommand,
    exec: execCommand,
    console: consoleCommand,
    sleep: sleepCommand,
    wake: wakeCommand,
    hold: holdCommand,
    url: urlCommand,
    checkpoint: checkpointCommand,
    checkpoints: checkpointsCommand,
    restore: restoreCommand,
    fork: forkCommand,
    image: imageCommand,
    info: infoCommand,
    login: loginCommand,
    host: hostCommand,
    hosts: hostsCommand,
    completion: async () => {
      const completion = await import('./commands/completion');

      return completion.completionCommand;
    },
  },
});
