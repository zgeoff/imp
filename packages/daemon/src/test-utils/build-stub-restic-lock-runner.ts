import type { CommandResult } from '../process/run-command';

// restic's exclusive commands; every other one shares the lock
const EXCLUSIVE_COMMANDS = new Set(['forget', 'prune', 'check']);

// what each command prints on success: `snapshots --json` an empty list,
// `backup --json` its summary line
const OUTPUT: Readonly<Record<string, string>> = {
  snapshots: '[]',
  backup: JSON.stringify({
    message_type: 'summary',
    snapshot_id: 'a1',
    files_new: 0,
    files_changed: 0,
    files_unmodified: 0,
    data_added: 0,
  }),
};

// createRestic's runner over restic's lock rule: a blocked command exits 11,
// or waits with --retry-lock; each holds the lock until stopCommand. `events`
// records each start, wait, refuse and end, in order.
export function buildStubResticLockRunner() {
  const lock = { exclusive: false, shared: 0 };
  const events: string[] = [];

  const running = new Map<string, () => void>();

  let changed = Promise.withResolvers<void>();

  const wakeWaiters = (): void => {
    changed.resolve();

    changed = Promise.withResolvers<void>();
  };

  const run = async (argv: readonly string[]): Promise<CommandResult> => {
    const args = argv.slice(argv.indexOf('restic') + 1);
    const retries = args[0] === '--retry-lock';
    const rest = retries ? args.slice(2) : args;
    const command = rest[0] ?? '';
    const exclusive = EXCLUSIVE_COMMANDS.has(command);

    // --no-lock takes no lock at all
    const locks = !rest.includes('--no-lock');
    const isBlocked = () => locks && (lock.exclusive || (exclusive && lock.shared > 0));

    if (running.has(command)) {
      throw new Error(`the stub restic already runs ${command}`);
    }

    if (isBlocked() && !retries) {
      events.push(`refuse ${command}`);

      return { exitCode: 11, stdout: '', stderr: 'unable to create lock in backend\n' };
    }

    if (isBlocked()) {
      events.push(`wait ${command}`);
    }

    while (isBlocked()) {
      await changed.promise;
    }

    if (locks && exclusive) {
      lock.exclusive = true;
    } else if (locks) {
      lock.shared += 1;
    }

    const done = Promise.withResolvers<void>();

    running.set(command, done.resolve);
    events.push(`start ${command}`);

    wakeWaiters();

    await done.promise;

    running.delete(command);

    if (locks && exclusive) {
      lock.exclusive = false;
    } else if (locks) {
      lock.shared -= 1;
    }

    events.push(`end ${command}`);

    wakeWaiters();

    return { exitCode: 0, stdout: OUTPUT[command] ?? '', stderr: '' };
  };

  // ends a command that holds the lock
  const stopCommand = (command: string): void => {
    const end = running.get(command);

    if (end === undefined) {
      throw new Error(`the stub restic does not run ${command}`);
    }

    end();
  };

  return { run, events, stopCommand };
}
