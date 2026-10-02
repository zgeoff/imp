import { UsageError } from './usage-error';

export interface HostFlagSplit {
  readonly host: string | null;
  readonly args: readonly string[];
}

// Takes `--host` out before citty sees it, so it goes anywhere before `--`
// and no command has to declare it. After `--`, it belongs to the command
// `imp exec` runs.
export function splitHostFlag(rawArgs: readonly string[]): HostFlagSplit {
  const separator = rawArgs.indexOf('--');
  const end = separator === -1 ? rawArgs.length : separator;
  const args: string[] = [];
  let host: string | null = null;

  for (let index = 0; index < end; index++) {
    const arg = rawArgs[index] ?? '';

    if (arg === '--host') {
      const value = rawArgs[index + 1];

      if (index + 1 >= end || value === undefined || value.startsWith('-')) {
        throw new UsageError('--host needs a saved host name (see imp host ls)');
      }

      host = value;
      index++;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);

      if (host === '') {
        throw new UsageError('--host needs a saved host name (see imp host ls)');
      }
    } else {
      args.push(arg);
    }
  }

  return { host, args: [...args, ...rawArgs.slice(end)] };
}
