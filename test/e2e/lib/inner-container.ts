import { runInImp, runShellInImp } from './imp-cli';
import { parseWholeNumber } from './parse-whole-number';
import { waitFor } from './wait-for';

// Thin glue over a live guest's inner container
// (docs/architecture/agent.md#the-inner-container), with nothing to test
// without one.

// the inner init's start time, in clock ticks since boot: it changes only
// when the container starts again
export async function readInitStart(name: string): Promise<number> {
  const start = await runShellInImp(name, "cut -d' ' -f22 /proc/1/stat");

  return parseWholeNumber(start, `${name}'s init start`);
}

// the guest's uptime in whole seconds, which a container restart keeps
export async function readUptime(name: string): Promise<number> {
  const uptime = await runShellInImp(name, 'cut -d. -f1 /proc/uptime');

  return parseWholeNumber(uptime, `${name}'s uptime`);
}

// waits until an exec reaches the inner container again, after a restart
export async function waitForInnerInit(name: string): Promise<void> {
  await waitFor(`the inner container in ${name}`, () => runInImp(name, 'true'), {
    timeoutMs: 30_000,
  });
}
