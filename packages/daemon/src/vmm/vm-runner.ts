import { sendShutdown } from '../agent-client/agent-requests';
import { waitForAgent } from '../agent-client/wait-for-agent';
import type { SlotAddress } from '../net/addressing';
import type { ImpPaths } from '../storage/data-layout';
import { createFirecrackerClient } from './firecracker-client';
import {
  isFirecrackerAlive,
  readLogTail,
  startFirecracker,
  stopProcess,
  waitForExit,
} from './firecracker-process';

const AGENT_DEADLINE_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 3000;

export interface VmPlan {
  readonly firecrackerBin: string;
  readonly kernelPath: string;
  readonly systemDrivePath: string;
  readonly paths: ImpPaths;
  readonly address: SlotAddress;
  readonly hostname: string;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly dns: readonly string[];
}

interface StartedVm {
  readonly pid: number;
  readonly firecrackerVersion: string;

  // milliseconds per step, for the create-time breakdown in the log
  readonly timings: Readonly<Record<string, number>>;
}

// Firecracker, behind an interface so the lifecycle can run against a fake.
export interface VmRunner {
  readonly startVm: (plan: VmPlan) => Promise<StartedVm>;

  // agent shutdown first when `graceful`, SIGKILL after the timeout
  readonly stopVm: (pid: number, paths: ImpPaths, graceful: boolean) => Promise<void>;
  readonly isVmAlive: (pid: number, paths: ImpPaths) => boolean;
  readonly isAgentReady: (paths: ImpPaths) => Promise<boolean>;
}

// The kernel cmdline: the system drive (vdb) is the initial root and the
// agent PID 1; imp.* parameters configure the guest (DESIGN 2.3).
export function buildBootArgs(plan: Readonly<VmPlan>): string {
  return [
    'console=ttyS0 reboot=k panic=1 pci=off',
    'i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd',
    'root=/dev/vdb rootfstype=squashfs ro init=/imp-agent',
    `imp.hostname=${plan.hostname}`,
    `imp.ip=${plan.address.guestIp}/${String(plan.address.prefixLength)}`,
    `imp.gw=${plan.address.hostIp}`,
    `imp.dns=${plan.dns.join(',')}`,
  ].join(' ');
}

export function createVmRunner(): VmRunner {
  const stopVm = async (pid: number, paths: ImpPaths, graceful: boolean): Promise<void> => {
    if (!isFirecrackerAlive(pid, paths.apiSocket)) {
      return;
    }

    if (graceful) {
      try {
        await sendShutdown(paths.vsockSocket);

        const exited = await waitForExit(pid, paths.apiSocket, SHUTDOWN_TIMEOUT_MS);

        if (exited) {
          return;
        }
      } catch {
        // the agent is gone or hung; kill below
      }
    }

    stopProcess(pid, 'SIGKILL');

    const killed = await waitForExit(pid, paths.apiSocket, KILL_TIMEOUT_MS);

    if (!killed) {
      throw new Error(`firecracker ${String(pid)} survived SIGKILL`);
    }
  };

  return {
    startVm: async (plan) => {
      const marks: Record<string, number> = {};
      let last = performance.now();

      const setMark = (step: string): void => {
        const now = performance.now();

        marks[step] = Math.round(now - last);
        last = now;
      };

      const pid = await startFirecracker(plan.firecrackerBin, plan.paths);

      setMark('spawn');

      try {
        const api = createFirecrackerClient(plan.paths.apiSocket);
        const versionPromise = api.getVersion();

        await api.putBootSource({
          kernelImagePath: plan.kernelPath,
          bootArgs: buildBootArgs(plan),
        });

        await api.putMachineConfig({ vcpuCount: plan.vcpus, memSizeMib: plan.memoryMib });

        // drives enumerate in PUT order: rootfs is vda, the system drive vdb;
        // neither is a Firecracker root device, which would add root=/dev/vda
        await api.putDrive({
          driveId: 'rootfs',
          pathOnHost: plan.paths.disk,
          isRootDevice: false,
          isReadOnly: false,
        });

        await api.putDrive({
          driveId: 'system',
          pathOnHost: plan.systemDrivePath,
          isRootDevice: false,
          isReadOnly: true,
        });

        await api.putVsock({ guestCid: 3, udsPath: plan.paths.vsockSocket });

        await api.putNetworkInterface({
          ifaceId: 'eth0',
          hostDevName: plan.address.tap,
          guestMac: plan.address.guestMac,
        });

        const firecrackerVersion = await versionPromise;

        setMark('configure');

        await api.instanceStart();

        setMark('instanceStart');

        await waitForAgent(plan.paths.vsockSocket, { deadlineMs: AGENT_DEADLINE_MS });

        setMark('agent');

        return { pid, firecrackerVersion, timings: marks };
      } catch (error) {
        stopProcess(pid, 'SIGKILL');

        const reason = error instanceof Error ? error.message : String(error);

        throw new Error(`boot failed: ${reason}\n${readLogTail(plan.paths.logFile)}`, {
          cause: error,
        });
      }
    },
    stopVm,
    isVmAlive: (pid, paths) => isFirecrackerAlive(pid, paths.apiSocket),
    isAgentReady: async (paths) => {
      try {
        await waitForAgent(paths.vsockSocket, { deadlineMs: 2000 });

        return true;
      } catch {
        return false;
      }
    },
  };
}
