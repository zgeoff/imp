import { hasPriorityValidationError, plugin } from 'gunshi/plugin';
import type { CommandContext } from 'gunshi/plugin';
import type { CommandIO } from './command-io';
import { CommandLineError } from './command-line-error';
import { checkHostName } from './host-store';
import { renderUsage } from './render-usage';

// what every command gets beside its own flags
export interface ImpzExtension {
  // the saved host `--host` named, or null to fall back on IMP_URL, then the
  // current host
  readonly host: string | null;
  readonly io: CommandIO;
}

// The flags every command takes: `--host` anywhere before `--`, and
// `--help` and `--version`, which answer instead of running the command.
// Each command reads its host and IO from `ctx.extensions.impz`.
export function buildImpzPlugin(io: CommandIO) {
  return plugin({
    id: 'impz',
    setup: (ctx) => {
      ctx.addGlobalOption('help', {
        type: 'boolean',
        short: 'h',
        description: 'Display this help message',
      });

      ctx.addGlobalOption('version', { type: 'boolean', description: 'Display this version' });

      ctx.addGlobalOption('host', {
        type: 'string',
        description: 'saved host to call (see impz host ls)',
      });

      ctx.decorateCommand((run) => (command) => {
        if (hasPriorityValidationError(command.validationError)) {
          throw toCommandLineError(command);
        }

        if (command.values['version'] === true) {
          return command.env.version;
        }

        if (command.values['help'] === true) {
          return renderUsage(command);
        }

        if (command.validationError !== undefined) {
          throw toCommandLineError(command);
        }

        return run(command);
      });
    },
    extension: (ctx): ImpzExtension => {
      const host: unknown = ctx.values['host'];

      return { host: typeof host === 'string' ? checkHostName(host) : null, io };
    },
  });
}

function toCommandLineError(ctx: Readonly<CommandContext>): CommandLineError {
  return new CommandLineError(
    ctx.commandPath.join(' '),
    ctx.validationError ?? new AggregateError([], 'refused'),
  );
}
