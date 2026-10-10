import { openSessionSocket, requireOutput } from './exec-socket';
import type { SessionOutput } from './exec-socket';
import { runInImp } from './imp-cli';
import { runInContainer } from './instance';
import { parseWholeNumber } from './parse-whole-number';
import { waitFor } from './wait-for';

// the template keys in `grep -l` output over the templates' meta.json files
export function parseTemplateKeys(listing: string): string[] {
  return listing
    .split('\n')
    .map((line) => /\/templates\/(?<key>[^\/]+)\/meta\.json$/v.exec(line.trim())?.groups?.['key'])
    .filter((key) => key !== undefined);
}

// Throws when a template of the memory size is there before a journey's
// first boot: the journey builds its own, so one there would serve it.
export function checkNoShapeTemplate(memoryMib: number, keys: readonly string[]): void {
  if (keys.length > 0) {
    throw new Error(
      `a boot template of ${String(memoryMib)} MiB is already there (${keys.join(', ')}); a run with --keep leaves one, so remove it first`,
    );
  }
}

// Thin glue over the host container and live guests for the boot-templates
// suite below.

// isn-probe (the e2e-ws image) prints the secret part of the TCP ISN
export async function readIsnSecret(name: string): Promise<number> {
  const stdout = await runInImp(name, 'isn-probe');

  return parseWholeNumber(stdout, `${name}'s isn-probe`);
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

// the keys of impd's boot templates of the memory size
export async function readShapeTemplateKeys(memoryMib: number): Promise<string[]> {
  const found = await runInContainer([
    'sh',
    '-c',
    `grep -l '"memoryMib": ${String(memoryMib)}' /var/lib/imp/templates/*/meta.json || true`,
  ]);

  return parseTemplateKeys(found.stdout);
}

export async function checkShapeTemplateAbsent(memoryMib: number): Promise<void> {
  const keys = await readShapeTemplateKeys(memoryMib);

  checkNoShapeTemplate(memoryMib, keys);
}

// until impd holds a boot template of the memory size; its key
export function waitForShapeTemplate(memoryMib: number): Promise<string> {
  return waitFor(
    `the boot template of ${String(memoryMib)} MiB`,
    async () => {
      const [key] = await readShapeTemplateKeys(memoryMib);

      if (key === undefined) {
        throw new Error('no template yet');
      }

      return key;
    },
    { timeoutMs: 120_000 },
  );
}

// impd finds a template by its files, so one gone is one it builds again
export async function removeShapeTemplates(memoryMib: number): Promise<void> {
  const keys = await readShapeTemplateKeys(memoryMib);

  for (const key of keys) {
    await runInContainer(['rm', '-rf', `/var/lib/imp/templates/${key}`]);
  }
}
