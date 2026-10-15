import { runShellInImp } from './imp-cli';
import { waitFor } from './wait-for';

// A guest script that exits 0 once a TCP socket listens on `port`, over IPv4
// or IPv6: /proc/net/tcp{,6} name the local port in hex and LISTEN as 0A.
export function buildListenCheck(port: number): string {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');

  return `awk '$4 == "0A" && $2 ~ /:${hex}$/ { found = 1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6`;
}

// waits until something in the imp listens on `port`
export async function waitForGuestListen(name: string, port: number): Promise<void> {
  await waitFor(`a listener on ${String(port)} in ${name}`, () =>
    runShellInImp(name, buildListenCheck(port)),
  );
}

// EstabResets from the Tcp lines of a guest's /proc/net/snmp: established
// connections that a RST ended
export function parseEstabResets(snmp: string): number {
  const [header = '', values = ''] = snmp.split('\n').filter((line) => line.startsWith('Tcp:'));
  const column = header.split(' ').indexOf('EstabResets');

  if (column === -1) {
    throw new Error(`no EstabResets in ${JSON.stringify(header)}`);
  }

  return Number(values.split(' ')[column]);
}

export async function readEstabResets(name: string): Promise<number> {
  const snmp = await runShellInImp(name, 'grep ^Tcp: /proc/net/snmp');

  return parseEstabResets(snmp);
}
