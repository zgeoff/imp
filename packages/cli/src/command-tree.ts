import { defineCommand } from 'citty';
import packageJson from '../package.json' with { type: 'json' };
import { backupCommand } from './commands/backup';
import { checkpointCommand, checkpointsCommand, restoreCommand } from './commands/checkpoints';
import { diskCommand } from './commands/disk';
import { eventsCommand } from './commands/events';
import { gcCommand } from './commands/gc';
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
import { mcpCommand } from './commands/mcp';
import { proxyCommand } from './commands/proxy';
import {
  auditCommand,
  grantCommand,
  grantsCommand,
  revokeCommand,
  secretCommand,
} from './commands/secrets';
import { attachCommand, sessionsCommand } from './commands/sessions';

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
    attach: attachCommand,
    sessions: sessionsCommand,
    sleep: sleepCommand,
    wake: wakeCommand,
    hold: holdCommand,
    url: urlCommand,
    proxy: proxyCommand,
    checkpoint: checkpointCommand,
    checkpoints: checkpointsCommand,
    restore: restoreCommand,
    fork: forkCommand,
    disk: diskCommand,
    gc: gcCommand,
    backup: backupCommand,
    image: imageCommand,
    secret: secretCommand,
    grant: grantCommand,
    revoke: revokeCommand,
    grants: grantsCommand,
    audit: auditCommand,
    events: eventsCommand,
    info: infoCommand,
    mcp: mcpCommand,
    login: loginCommand,
    host: hostCommand,
    hosts: hostsCommand,
    completion: async () => {
      const completion = await import('./commands/completion');

      return completion.completionCommand;
    },
  },
});
