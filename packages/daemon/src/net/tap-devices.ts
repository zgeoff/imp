import { runCommand } from '../process/run-command';
import type { CommandResult } from '../process/run-command';
import type { SlotAddress } from './addressing';

// Tap devices for imp slots (docs/architecture/networking.md#addressing). An
// interface, so tests fake it.
export interface TapDevices {
  // creates `imp<slot>` with the host end of the /30 and brings it up;
  // succeeds when it already exists
  readonly setupTap: (address: SlotAddress) => Promise<void>;

  // succeeds when it is already gone
  readonly removeTap: (tap: string) => Promise<void>;
}

type RunCommand = (argv: readonly string[]) => Promise<CommandResult>;

export function createTapDevices(run: RunCommand = runCommand): TapDevices {
  // `tolerated`: stderr fragments that mean the change is already in place
  const runIp = async (args: readonly string[], tolerated: readonly string[]): Promise<void> => {
    const result = await run(['ip', ...args]);

    const stderr = result.stderr.toLowerCase();

    if (result.exitCode !== 0 && !tolerated.some((fragment) => stderr.includes(fragment))) {
      throw new Error(`ip ${args.join(' ')}: ${result.stderr.trim()}`);
    }
  };

  return {
    setupTap: async (address) => {
      const cidr = `${address.hostIp}/${String(address.prefixLength)}`;

      await runIp(['tuntap', 'add', address.tap, 'mode', 'tap'], ['exists', 'busy']);
      await runIp(['addr', 'add', cidr, 'dev', address.tap], ['exists', 'already assigned']);
      await runIp(['link', 'set', address.tap, 'up'], []);
    },
    removeTap: async (tap) => {
      await runIp(['link', 'del', tap], ['cannot find', 'does not exist']);
    },
  };
}
