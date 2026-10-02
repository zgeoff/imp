import { runCommand } from '../process/run-command';
import type { CommandResult } from '../process/run-command';
import type { SlotAddress } from './addressing';
import { GATEWAY_IP6 } from './addressing6';

// Tap devices for imp slots (docs/architecture/networking.md#addressing). An
// interface, so tests fake it.
export interface TapDevices {
  // creates `imp<slot>` with the host end of the /30 and brings it up;
  // succeeds when it already exists. With IPv6, the tap also gets the
  // gateway fe80::1 and a route to the imp's /128.
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

  // a kernel with IPv6 disabled has no keys for it; the tap then has no
  // IPv6 to guard
  const runSysctls = async (tap: string, values: Readonly<Record<string, string>>) => {
    for (const [key, value] of Object.entries(values)) {
      const result = await run(['sysctl', '-qw', `net.ipv6.conf.${tap}.${key}=${value}`]);

      if (result.exitCode !== 0 && !result.stderr.includes('cannot stat')) {
        throw new Error(`sysctl net.ipv6.conf.${tap}.${key}: ${result.stderr.trim()}`);
      }
    }
  };

  return {
    setupTap: async (address) => {
      const cidr = `${address.hostIp}/${String(address.prefixLength)}`;
      const ipv6 = address.guestIp6 !== null;

      await runIp(['tuntap', 'add', address.tap, 'mode', 'tap'], ['exists', 'busy']);
      await runIp(['addr', 'add', cidr, 'dev', address.tap], ['exists', 'already assigned']);

      // before the link is up: a guest never sets the host's routes, with
      // or without IPv6 (docs/architecture/networking.md#ipv6)
      await runSysctls(address.tap, {
        accept_ra: '0',
        accept_redirects: '0',
        ...(ipv6 && { disable_ipv6: '0' }),
      });

      if (ipv6) {
        await runIp(
          ['addr', 'add', `${GATEWAY_IP6}/64`, 'dev', address.tap, 'nodad'],
          ['exists', 'already assigned'],
        );
      }

      await runIp(['link', 'set', address.tap, 'up'], []);

      if (address.guestIp6 !== null) {
        await runIp(['-6', 'route', 'replace', `${address.guestIp6}/128`, 'dev', address.tap], []);
      }
    },
    removeTap: async (tap) => {
      await runIp(['link', 'del', tap], ['cannot find', 'does not exist']);
    },
  };
}
