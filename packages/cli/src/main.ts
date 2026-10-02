#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty';
import packageJson from '../package.json' with { type: 'json' };
import { checkpointCommand, checkpointsCommand, restoreCommand } from './commands/checkpoints';
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

const main = defineCommand({
  meta: {
    name: 'imp',
    version: packageJson.version,
    description: 'Persistent Linux microVMs that sleep when idle and wake on request',
  },
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
    mcp: mcpCommand,
  },
});

// runMain shows help when --help appears anywhere, and citty would parse
// the command's own flags, so it sees only the arguments before `--`;
// `imp exec` reads the command after it from process.argv
const rawArgs = process.argv.slice(2);
const separator = rawArgs.indexOf('--');

await runMain(main, { rawArgs: separator === -1 ? rawArgs : rawArgs.slice(0, separator) });
