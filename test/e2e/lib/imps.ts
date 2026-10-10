import { listImps, runImp, runInImp, runShellInImp, tryImp } from './imp-cli';
import { waitFor } from './wait-for';

// ignores imps already gone
export async function removeImps(...names: readonly string[]): Promise<void> {
  for (const name of names) {
    await tryImp(['rm', name]);
  }
}

export async function waitForExec(name: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(`${name} to accept exec`, () => runInImp(name, 'true'), { timeoutMs });
}

// `imp new NAME ARGS...`, then waits until exec works; returns what it printed
export async function createImp(name: string, ...args: readonly string[]): Promise<string> {
  const out = await runImp('new', name, ...args);

  await waitForExec(name);

  return out;
}

// keeps the imp awake, so the short idle timeout does not sleep it between steps
export async function holdImp(name: string): Promise<void> {
  await runImp('hold', name, '30m');
}

export async function removeImpsWithPrefix(prefix: string): Promise<void> {
  const rows = await listImps();

  const stale = rows.map((row) => row.name).filter((name) => name.startsWith(prefix));

  await removeImps(...stale);
}

export async function writeGuestFile(name: string, path: string, content: string): Promise<void> {
  await runShellInImp(name, `echo ${content} > ${path} && sync`);
}

// "none" when the file does not exist
export function readGuestFile(name: string, path: string): Promise<string> {
  return runShellInImp(name, `cat ${path} 2>/dev/null || echo none`);
}

// a guest script that prints `gone` once nothing is at `path`, a socket
// included, and `there` while something is
export function buildPathGoneCheck(path: string): string {
  return `if [ -e '${path}' ]; then echo there; else echo gone; fi`;
}

// waits until nothing is at `path` in the imp, such as a socket a forward or
// a connection made and must remove once it ends
export async function waitForGuestPathGone(name: string, path: string): Promise<void> {
  await waitFor(`${path} to go`, async () => {
    const state = await runShellInImp(name, buildPathGoneCheck(path));

    if (state !== 'gone') {
      throw new Error(`${path} is still there`);
    }
  });
}

export interface GuestIdentity {
  readonly machineId: string;

  // the fingerprint of the ed25519 host key
  readonly hostKey: string;
}

// what makes a guest a machine of its own; the image needs ssh-keygen
export async function readGuestIdentity(name: string): Promise<GuestIdentity> {
  const machineId = await readGuestFile(name, '/etc/machine-id');

  const hostKey = await runShellInImp(
    name,
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f2",
  );

  return { machineId, hostKey };
}
