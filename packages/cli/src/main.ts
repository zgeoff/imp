#!/usr/bin/env bun
import { runMain } from 'citty';
import { mainCommand } from './command-tree';
import { splitHostFlag } from './host-flag';
import { checkHostName } from './host-store';
import { printError } from './run-action';

// runMain shows help when --help appears anywhere, and citty would parse
// the command's own flags, so it sees only the arguments before `--`;
// `imp exec` reads the command after it from process.argv
try {
  const split = splitHostFlag(process.argv.slice(2));
  const separator = split.args.indexOf('--');
  const args = separator === -1 ? [...split.args] : split.args.slice(0, separator);

  // citty hands a subcommand only its own arguments, never `data`, so
  // `--host` goes last for the command that runs (define-command.ts); with
  // no subcommand, --version and --help need their flag alone
  const hasSubcommand = args.some((arg) => !arg.startsWith('-'));

  if (split.host !== null) {
    const host = checkHostName(split.host);

    if (hasSubcommand) {
      args.push(`--host=${host}`);
    }
  }

  await runMain(mainCommand, { rawArgs: args });
} catch (error) {
  printError(error);
}
