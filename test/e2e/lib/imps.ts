import { afterAll } from 'bun:test';
import { config } from './config';
import { listImps, runImp, runInImp, runShellInImp, tryImp } from './imp-cli';
import { waitFor } from './wait-for';

// every imp this suite process created, for cleanup
const created = new Set<string>();

// ignores imps already gone
export async function removeImps(...names: readonly string[]): Promise<void> {
  for (const name of names) {
    await tryImp(['rm', name]);

    created.delete(name);
  }
}

// removes the suite's imps when it ends, unless the run keeps them (--keep)
export function useImpCleanup(): void {
  afterAll(async () => {
    if (!config.keep) {
      await removeImps(...created);
    }
  });
}

// for imps that something other than createImp makes, such as a fork
export function registerImp(name: string): void {
  created.add(name);
}

export async function waitForExec(name: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(`${name} to accept exec`, () => runInImp(name, 'true'), { timeoutMs });
}

// `imp new NAME ARGS...`, then waits until exec works; returns what it printed
export async function createImp(name: string, ...args: readonly string[]): Promise<string> {
  created.add(name);

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
