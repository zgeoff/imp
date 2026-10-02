#!/usr/bin/env bun
import { runMain } from 'citty';
import { setSelectedHost } from './cli-config';
import { mainCommand } from './command-tree';
import { splitHostFlag } from './host-flag';
import { printError } from './run-action';

// runMain shows help when --help appears anywhere, and citty would parse
// the command's own flags, so it sees only the arguments before `--`;
// `imp exec` reads the command after it from process.argv
try {
  const split = splitHostFlag(process.argv.slice(2));
  const args = split.args;
  const separator = args.indexOf('--');

  if (split.host !== null) {
    setSelectedHost(split.host);
  }

  await runMain(mainCommand, {
    rawArgs: separator === -1 ? [...args] : args.slice(0, separator),
  });
} catch (error) {
  printError(error);
}
