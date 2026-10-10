import { openSessionSocket, requireOutput } from './exec-socket';
import type { SessionOutput } from './exec-socket';
import { runInImp } from './imp-cli';
import { runInContainer } from './instance';
import { waitFor } from './wait-for';

// Thin glue over the host container and live guests for the boot-templates
// suite, with nothing to test without them.

// isn-probe (the e2e-ws image) prints the secret part of the TCP ISN
export async function readIsnSecret(name: string): Promise<number> {
  const stdout = await runInImp(name, 'isn-probe');

  return Number(stdout.trim());
}

export async function readMac(name: string): Promise<string> {
  const stdout = await runInImp(name, 'cat', '/sys/class/net/eth0/address');

  return stdout.trim();
}

// a session's output identity: its boot, and the imp's last cold boots
export async function readSessionOutput(name: string): Promise<SessionOutput> {
  const opened = await openSessionSocket({
    type: 'start',
    name,
    session: 'boot',
    argv: ['sleep', 'infinity'],
    tty: true,
  });

  const output = requireOutput(opened);

  opened.close();

  return output;
}

// until impd holds a boot template of the memory size
export function waitForShapeTemplate(memoryMib: number): Promise<void> {
  return waitFor(
    `the boot template of ${String(memoryMib)} MiB`,
    async () => {
      const found = await runInContainer([
        'sh',
        '-c',
        `grep -l '"memoryMib": ${String(memoryMib)}' /var/lib/imp/templates/*/meta.json`,
      ]);

      if (found.exitCode !== 0) {
        throw new Error('no template yet');
      }
    },
    { timeoutMs: 120_000 },
  );
}
