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
  urlCommand,
  wakeCommand,
} from './commands/imps';
import { infoCommand } from './commands/info';

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
  },
});

await runMain(main);
