#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from 'citty';
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
  },
});

// runMain shows help when --help appears anywhere, so arguments after `--`
// (the command for `imp exec`) bypass it
const rawArgs = process.argv.slice(2);
const separator = rawArgs.indexOf('--');
const ownArgs = separator === -1 ? rawArgs : rawArgs.slice(0, separator);

if (ownArgs.length === rawArgs.length || ownArgs.some((arg) => arg === '--help' || arg === '-h')) {
  await runMain(main, { rawArgs: ownArgs });
} else {
  try {
    await runCommand(main, { rawArgs });
  } catch (error) {
    console.error(`imp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
