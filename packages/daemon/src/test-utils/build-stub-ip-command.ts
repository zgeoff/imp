import { runChecked } from '../process/run-command';
import type { CommandResult } from '../process/run-command';

interface StubIpCommandOptions {
  // stderr for each call whose argv, joined by spaces, starts with the key
  // (`ip tuntap`, `sysctl -qw`, `ip6tables -w -t raw`); that call exits 2
  // with it, as ip does for a failed change
  readonly failures?: Readonly<Record<string, string>>;

  // the sysctl keys the kernel has, with their values; `sysctl -n` and
  // `sysctl -qw` of any other key fail as sysctl does for a missing key
  readonly sysctls?: Readonly<Record<string, string>>;

  // what a read prints, by its whole argv joined by spaces (`ip -4 route
  // show`, `ip6tables -w -t filter -S`)
  readonly outputs?: Readonly<Record<string, string>>;
}

// the changes impd makes with ip, by the start of their argv; each succeeds
// and prints nothing
const CHANGES = [
  'ip tuntap add ',
  'ip link set ',
  'ip link del ',
  'ip addr add ',
  'ip -6 route replace ',
];

// `ip`, `ip6tables` and `sysctl` at their command layer, as the `run` of
// the taps, the host route reads and the IPv6 rule check. A read with no
// output, or a command it does not model, rejects.
export function buildStubIpCommand(options: Readonly<StubIpCommandOptions> = {}) {
  const calls: string[] = [];

  const sysctls = new Map(Object.entries(options.sysctls ?? {}));

  const readSysctl = (key: string): CommandResult => {
    const value = sysctls.get(key);

    return value === undefined
      ? buildMissingKeyResult(key)
      : { exitCode: 0, stdout: `${value}\n`, stderr: '' };
  };

  const writeSysctl = (assignment: string): CommandResult => {
    const [key = '', value = ''] = assignment.split('=');

    if (!sysctls.has(key)) {
      return buildMissingKeyResult(key);
    }

    sysctls.set(key, value);

    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const runLine = (argv: readonly string[], line: string): CommandResult => {
    const failure = Object.entries(options.failures ?? {}).find(([prefix]) =>
      line.startsWith(prefix),
    );

    if (failure !== undefined) {
      return { exitCode: 2, stdout: '', stderr: `${failure[1]}\n` };
    }

    if (argv.length === 3 && argv[0] === 'sysctl' && argv[1] === '-n') {
      return readSysctl(argv[2] ?? '');
    }

    if (argv.length === 3 && argv[0] === 'sysctl' && argv[1] === '-qw') {
      return writeSysctl(argv[2] ?? '');
    }

    if (CHANGES.some((change) => line.startsWith(change))) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const output = options.outputs?.[line];

    if (output === undefined) {
      throw new Error(`stub ip: no model for ${line}`);
    }

    return { exitCode: 0, stdout: output, stderr: '' };
  };

  const run = async (argv: readonly string[]): Promise<CommandResult> => {
    const line = argv.join(' ');

    calls.push(line);

    await Promise.resolve();

    return runLine(argv, line);
  };

  return {
    // every argv, joined by spaces, in order
    calls,

    // answers as runCommand does
    run,

    // the real runChecked over `run`
    runChecked: (argv: readonly string[]): Promise<string> => runChecked(argv, {}, run),

    // a sysctl key's value now, or undefined for a key the kernel lacks
    readSysctl: (key: string): string | undefined => sysctls.get(key),
  };
}

// sysctl's answer for a key the kernel does not have
function buildMissingKeyResult(key: string): CommandResult {
  return {
    exitCode: 255,
    stdout: '',
    stderr: `sysctl: cannot stat /proc/sys/${key.replaceAll('.', '/')}: No such file or directory\n`,
  };
}
