import type { ImpContext } from '../imps/imp-context';
import type { ImpLock } from '../imps/imp-lock';
import type { ImpVmOps } from '../imps/imp-vm-ops';
import { readErrorMessage } from '../read-error-message';
import { createAgentWatchdog } from './agent-watchdog';
import type { AgentWatchdog } from './agent-watchdog';
import { writeWatchdogSnapshot } from './write-watchdog-snapshot';

// the confirming ping: longer than the idle loop's 1 s, for a guest that is
// only busy
const CONFIRM_MS = 5000;

// The watchdog over impd's own imps: its recovery takes the imp's lock the
// way background sleeps do, and gives way to any operation holding it.
export function createImpWatchdog(
  context: ImpContext,
  lock: ImpLock,
  ops: ImpVmOps,
): AgentWatchdog {
  return createAgentWatchdog({
    timeoutMs: context.config.watchdogTimeoutS * 1000,
    action: context.config.watchdogAction,
    now: context.now,
    log: context.log,
    confirmSilent: async (imp) =>
      !(await context.vms.isAgentReady(context.findPaths(imp.id), CONFIRM_MS)),
    recover: async (imp, action) => {
      const result = await lock.tryWithImpId(imp.id, async (fresh) => {
        if (fresh?.state !== 'running') {
          return;
        }

        if (action === 'snapshot') {
          await writeWatchdogSnapshot(context, fresh);
        }

        try {
          await ops.startFreshImpVm(
            fresh,
            'the watchdog restarted it: its agent stopped answering',
          );

          context.log(`impd: ${fresh.name}: the watchdog booted it cold`);
        } catch (error) {
          context.log(
            `impd: ${fresh.name}: the watchdog restart failed: ${readErrorMessage(error)}`,
          );
        }
      });

      return result.ran;
    },
  });
}
