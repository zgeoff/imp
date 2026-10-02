import { readFileSync } from 'node:fs';
import { runCommand } from '../process/run-command';
import type { CommandResult } from '../process/run-command';
import type { SlotAddress } from './addressing';
import { GATEWAY_IP6 } from './addressing6';

// Tap devices for imp slots (docs/architecture/networking.md#addressing). An
// interface, so tests fake it.
export interface TapDevices {
  // creates `imp<slot>` with the host end of the /30 and brings it up. With
  // IPv6, the tap also gets the gateway fe80::1 and a route to the imp's
  // /128. A jailed Firecracker owns its tap (docs/architecture/daemon.md#the-jailer).
  readonly setupTap: (address: SlotAddress, owner?: TapOwner | null) => Promise<void>;

  // succeeds when it is already gone
  readonly removeTap: (tap: string) => Promise<void>;
}

interface TapOwner {
  readonly uid: number;
  readonly gid: number;
}

type RunCommand = (argv: readonly string[]) => Promise<CommandResult>;

// a tap's owner and group from sysfs, -1 for none; null when it is not there
type ReadOwner = (tap: string) => TapOwner | null;

export function createTapDevices(
  run: RunCommand = runCommand,
  readOwner: ReadOwner = readTapOwner,
): TapDevices {
  // `tolerated`: stderr fragments that mean the change is already in place;
  // false then, true when this call made it
  const runIp = async (args: readonly string[], tolerated: readonly string[]): Promise<boolean> => {
    const result = await run(['ip', ...args]);

    const stderr = result.stderr.toLowerCase();

    if (result.exitCode !== 0 && !tolerated.some((fragment) => stderr.includes(fragment))) {
      throw new Error(`ip ${args.join(' ')}: ${result.stderr.trim()}`);
    }

    return result.exitCode === 0;
  };

  // A kernel with IPv6 disabled has no keys for it; the tap then has no
  // IPv6 to guard. A key that already holds its value (a tap takes the
  // container's defaults) is not written, so a read-only /proc/sys works.
  const runSysctls = async (tap: string, values: Readonly<Record<string, string>>) => {
    for (const [key, value] of Object.entries(values)) {
      const name = `net.ipv6.conf.${tap}.${key}`;

      const current = await run(['sysctl', '-n', name]);

      if (current.exitCode === 0 && current.stdout.trim() === value) {
        continue;
      }

      const result = await run(['sysctl', '-qw', `${name}=${value}`]);

      if (result.exitCode !== 0 && !result.stderr.includes('cannot stat')) {
        throw new Error(`sysctl ${name}: ${result.stderr.trim()}`);
      }
    }
  };

  const removeTap = async (tap: string): Promise<void> => {
    await runIp(['link', 'del', tap], ['cannot find', 'does not exist']);
  };

  return {
    setupTap: async (address, owner = null) => {
      const cidr = `${address.hostIp}/${String(address.prefixLength)}`;
      const ipv6 = address.guestIp6 !== null;
      const current = readOwner(address.tap);

      if (owner !== null && current !== null && !isSameOwner(current, owner)) {
        await removeTap(address.tap);
      }

      const ownerArgs =
        owner === null ? [] : ['user', String(owner.uid), 'group', String(owner.gid)];

      const isNew = await runIp(
        ['tuntap', 'add', address.tap, 'mode', 'tap', ...ownerArgs],
        ['exists', 'busy'],
      );

      // the slot's MAC, not a random one, so a guest woken on another host
      // still knows its gateway (docs/architecture/networking.md#addressing);
      // a tap that exists keeps its own, as its guest knows it
      if (isNew) {
        await runIp(['link', 'set', address.tap, 'address', address.hostMac], []);
      }

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
    removeTap,
  };
}

function isSameOwner(a: Readonly<TapOwner>, b: Readonly<TapOwner>): boolean {
  return a.uid === b.uid && a.gid === b.gid;
}

function readTapOwner(tap: string): TapOwner | null {
  try {
    const dir = `/sys/class/net/${tap}`;

    return {
      uid: Number(readFileSync(`${dir}/owner`, 'utf8').trim()),
      gid: Number(readFileSync(`${dir}/group`, 'utf8').trim()),
    };
  } catch {
    return null;
  }
}
