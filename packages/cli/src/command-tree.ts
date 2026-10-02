import { defineCommand } from 'citty';
import packageJson from '../package.json' with { type: 'json' };
import { backupCommand } from './commands/backup';
import { checkpointCommand, checkpointsCommand, restoreCommand } from './commands/checkpoints';
import { cpCommand } from './commands/cp';
import { setCommand, topCommand } from './commands/cpu';
import { diskCommand } from './commands/disk';
import { eventsCommand } from './commands/events';
import { exposeCommand, unexposeCommand } from './commands/expose';
import { gcCommand } from './commands/gc';
import { hostCommand, hostsCommand, loginCommand } from './commands/hosts';
import { imageCommand, templateCommand } from './commands/image';
import {
  consoleCommand,
  execCommand,
  forkCommand,
  holdCommand,
  lsCommand,
  newCommand,
  policyCommand,
  rmCommand,
  sleepCommand,
  startCommand,
  stopCommand,
  urlCommand,
  wakeCommand,
} from './commands/imps';
import { infoCommand } from './commands/info';
import { mcpCommand } from './commands/mcp';
import { netCommand } from './commands/networks';
import { proxyCommand } from './commands/proxy';
import {
  auditCommand,
  grantCommand,
  grantsCommand,
  revokeCommand,
  secretCommand,
} from './commands/secrets';
import { logsCommand, serviceCommand } from './commands/services';
import { attachCommand, sessionsCommand } from './commands/sessions';
import { tokenCommand } from './commands/tokens';

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
    service: serviceCommand,
    logs: logsCommand,
    sleep: sleepCommand,
    wake: wakeCommand,
    hold: holdCommand,
    set: setCommand,
    top: topCommand,
    url: urlCommand,
    proxy: proxyCommand,
    cp: cpCommand,
    policy: policyCommand,
    expose: exposeCommand,
    unexpose: unexposeCommand,
    net: netCommand,
    checkpoint: checkpointCommand,
    checkpoints: checkpointsCommand,
    restore: restoreCommand,
    fork: forkCommand,
    disk: diskCommand,
    gc: gcCommand,
    backup: backupCommand,
    image: imageCommand,
    template: templateCommand,
    secret: secretCommand,
    grant: grantCommand,
    revoke: revokeCommand,
    grants: grantsCommand,
    audit: auditCommand,
    token: tokenCommand,
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
