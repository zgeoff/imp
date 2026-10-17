#!/usr/bin/env bun
import { isCommandNotFoundError } from 'gunshi';
import { cli } from 'gunshi/bone';
import packageJson from '../package.json' with { type: 'json' };
import { buildProcessIO } from './command-io';
import type { CommandIO } from './command-io';
import { mainCommand, subCommands } from './command-tree';
import { CommandExitError, CommandLineError, UsageError } from './errors';
import { formatValidationError } from './format-validation-error';
import { buildImpzPlugin } from './impz-plugin';
import { PromptCancelledError } from './read-token';
import { formatError } from './run-action';
import { toSignalExitCode } from './to-signal-exit-code';

interface CliOutcome {
  readonly code: number;

  // the command left handles open, such as a terminal in raw mode, so the
  // process exits at once instead of when they close
  readonly mustExit: boolean;
}

// Runs one impz command line to its end. A failure prints one line on stderr
// and maps to its exit code: 2 for a usage error, 1 for any other.
export async function runCLI(args: readonly string[], io: CommandIO): Promise<CliOutcome> {
  try {
    const rendered = await cli([...args], mainCommand, {
      name: 'impz',
      version: packageJson.version,
      description: mainCommand.description,
      subCommands,
      strict: true,
      plugins: [buildImpzPlugin(io)],
    });

    if (rendered !== undefined && rendered !== '') {
      io.print(rendered);
    }

    return { code: 0, mustExit: false };
  } catch (error) {
    return printFailure(error, io);
  }
}

// the failure's line on stderr, and the exit code it maps to
function printFailure(error: unknown, io: CommandIO): CliOutcome {
  if (error instanceof CommandExitError) {
    return { code: error.code, mustExit: error.mustExit };
  }

  if (error instanceof PromptCancelledError) {
    // a Ctrl-C at the prompt, as a shell reports it
    return { code: toSignalExitCode('SIGINT') ?? 1, mustExit: false };
  }

  const usage = formatUsageError(error);

  if (usage !== null) {
    io.printError(`impz: ${usage}`);

    return { code: 2, mustExit: false };
  }

  io.printError(`impz: ${formatError(error)}`);

  return { code: 1, mustExit: false };
}

// the line for a mistake in the command line, or null for any other failure
function formatUsageError(error: unknown): string | null {
  if (error instanceof UsageError) {
    return error.message;
  }

  if (error instanceof CommandLineError) {
    return formatRefusal(error.refusal, error.command);
  }

  if (isCommandNotFoundError(error)) {
    return `unknown command ${error.commandName} (see impz --help)`;
  }

  return error instanceof AggregateError ? formatRefusal(error, '') : null;
}

function formatRefusal(error: AggregateError, command: string): string | null {
  const errors: readonly unknown[] = error.errors;
  const notFound = errors.find((each) => isCommandNotFoundError(each));

  if (notFound !== undefined) {
    return `unknown command ${notFound.commandName} (see impz --help)`;
  }

  return formatValidationError(error, command);
}

if (import.meta.main) {
  const outcome = await runCLI(process.argv.slice(2), buildProcessIO());

  if (outcome.mustExit) {
    process.exit(outcome.code);
  }

  process.exitCode = outcome.code;
}
