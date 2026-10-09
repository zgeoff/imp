import type { CommandResult } from '../process/run-command';

interface StubIpCommandOptions {
  // stderr for each call whose argv, joined by spaces, starts with the key
  // (`ip tuntap`, `sysctl -qw`, `ip6tables -w -t raw`); that call exits 2
  // with it, as ip does for a failed change
  readonly failures?: Readonly<Record<string, string>>;

  // what `sysctl -n <key>` prints for each key; every other key reads 1
  readonly sysctls?: Readonly<Record<string, string>>;

  // what a read prints, by its whole argv joined by spaces (`ip -4 route
  // show`, `ip6tables -w -t filter -S`); any other call prints nothing
  readonly outputs?: Readonly<Record<string, string>>;
}

// `ip`, `ip6tables` and `sysctl` at their command layer, as the `run` that
// createTapDevices, the host route reads and the IPv6 rule check take; it
// changes nothing on the host.
export function buildStubIpCommand(options: Readonly<StubIpCommandOptions> = {}) {
  const calls: string[] = [];

  const run = (argv: readonly string[]): Promise<CommandResult> => {
    const line = argv.join(' ');

    calls.push(line);

    const failure = Object.entries(options.failures ?? {}).find(([prefix]) =>
      line.startsWith(prefix),
    );

    if (failure !== undefined) {
      return Promise.resolve({ exitCode: 2, stdout: '', stderr: `${failure[1]}\n` });
    }

    if (argv[0] === 'sysctl' && argv[1] === '-n') {
      const value = options.sysctls?.[argv[2] ?? ''] ?? '1';

      return Promise.resolve({ exitCode: 0, stdout: `${value}\n`, stderr: '' });
    }

    return Promise.resolve({ exitCode: 0, stdout: options.outputs?.[line] ?? '', stderr: '' });
  };

  return {
    // every argv, joined by spaces, in order
    calls,

    // answers as runCommand does
    run,

    // throws with stderr on a non-zero exit, as runChecked does
    runChecked: async (argv: readonly string[]): Promise<string> => {
      const result = await run(argv);

      if (result.exitCode !== 0) {
        throw new Error(
          `${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
        );
      }

      return result.stdout;
    },
  };
}
