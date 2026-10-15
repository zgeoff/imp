import { tryImp } from './imp-cli';

// Thin glue over a live guest: whether a command, a fetch or a TCP dial from
// it succeeds, for the network suites' reachability checks.

// the shell exits 0 when the command did
export async function tryInImp(name: string, script: string): Promise<boolean> {
  const result = await tryImp(['exec', name, '--', 'sh', '-c', script]);

  return result.exitCode === 0;
}

export function tryGetFromImp(name: string, url: string): Promise<boolean> {
  return tryInImp(name, `wget -q -T 5 -O /dev/null ${url}`);
}

// a TCP dial by busybox nc, from the source address when one is given
export function tryDialFromImp(
  name: string,
  target: string,
  port: number,
  source = '',
): Promise<boolean> {
  const from = source === '' ? '' : `-s ${source}`;

  return tryInImp(name, `echo | nc -w 3 ${from} ${target} ${String(port)} >/dev/null`);
}
