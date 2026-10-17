import { lazy } from 'gunshi';
import { backupCommand } from '../commands/backup';
import { checkpointCommand, checkpointsCommand, restoreCommand } from '../commands/checkpoints';
import { cpCommand } from '../commands/cp';
import { setCommand, topCommand } from '../commands/cpu';
import { dbCommand } from '../commands/db';
import { diskCommand } from '../commands/disk';
import { eventsCommand } from '../commands/events';
import { exposeCommand, unexposeCommand } from '../commands/expose';
import { gcCommand } from '../commands/gc';
import { hostCommand, hostsCommand, loginCommand } from '../commands/hosts';
import { imageCommand, templateCommand } from '../commands/image';
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
} from '../commands/imps';
import { infoCommand } from '../commands/info';
import { mcpCommand } from '../commands/mcp';
import { moveCommand } from '../commands/move';
import { netCommand } from '../commands/networks';
import { oauthCommand } from '../commands/oauth';
import { proxyCommand } from '../commands/proxy';
import {
  auditCommand,
  grantCommand,
  grantsCommand,
  revokeCommand,
  secretCommand,
} from '../commands/secrets';
import { logsCommand, serviceCommand } from '../commands/services';
import { attachCommand, sessionsCommand } from '../commands/sessions';
import { tokenCommand } from '../commands/tokens';
import { defineGroup } from './define-command';

// Every imp command. `completion` walks this tree to write its scripts, so
// it loads lazily: a static import would be a cycle.
export const subCommands = {
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
  move: moveCommand,
  disk: diskCommand,
  gc: gcCommand,
  db: dbCommand,
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
  oauth: oauthCommand,
  login: loginCommand,
  host: hostCommand,
  hosts: hostsCommand,
  completion: lazy(
    async () => {
      const completion = await import('../commands/completion');

      return completion.completionCommand;
    },
    {
      name: 'completion',
      description: 'Print the shell completion script (bash, zsh or fish)',
    },
  ),
};

export const mainCommand = defineGroup({
  name: 'impz',
  description: 'Persistent Linux microVMs that sleep when idle and wake on request',
  subCommands,
});
