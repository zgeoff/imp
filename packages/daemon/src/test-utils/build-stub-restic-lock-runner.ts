import type { CommandResult } from '../process/run-command';

// restic's exclusive commands; unlock takes no lock, every other one shares it
const EXCLUSIVE_COMMANDS = new Set(['forget', 'prune', 'check']);
const UNLOCKED_COMMANDS = new Set(['unlock']);

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

// restic's answer to a lock it could not take, at once or after --retry-lock
const LOCKED: CommandResult = {
  exitCode: 11,
  stdout: '',
  stderr: 'unable to create lock in backend\n',
};

// createRestic's runner over restic's lock rule: a blocked command exits 11,
// or with --retry-lock waits until the lock frees or stopWaits ends its wait.
// Each holds the lock until stopCommand; `events` records each step in order.
export function buildStubResticLockRunner() {
  const lock = { exclusive: false, shared: 0 };
  const events: string[] = [];

  const running = new Map<string, () => void>();

  const waits = { expired: 0 };
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
    const locks = !rest.includes('--no-lock') && !UNLOCKED_COMMANDS.has(command);
    const isBlocked = () => locks && (lock.exclusive || (exclusive && lock.shared > 0));
    const waitStartedAt = waits.expired;

    if (running.has(command)) {
      throw new Error(`the stub restic already runs ${command}`);
    }

    if (isBlocked() && !retries) {
      events.push(`refuse ${command}`);

      return LOCKED;
    }

    if (isBlocked()) {
      events.push(`wait ${command}`);
    }

    while (isBlocked()) {
      if (waits.expired > waitStartedAt) {
        events.push(`give up ${command}`);

        return LOCKED;
      }

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

  // as --retry-lock's wait running out: each command waiting now exits 11
  const stopWaits = (): void => {
    waits.expired += 1;

    wakeWaiters();
  };

  // settles every command, for a test's cleanup: waits end and runs stop
  const stopAll = (): void => {
    stopWaits();

    for (const end of running.values()) {
      end();
    }
  };

  return { run, events, stopCommand, stopWaits, stopAll };
}
