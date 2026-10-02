import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { sendGrow, sendPing, sendResumed, sendShutdown } from '../agent-client/agent-requests';
import { waitForAgent } from '../agent-client/wait-for-agent';
import type { SlotAddress } from '../net/addressing';
import { runCommand } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
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
const WAKE_AGENT_DEADLINE_MS = 10_000;

// a sleep asks under the imp's lock: a wedged agent must not hold it long
const UPTIME_PING_TIMEOUT_MS = 250;

export interface VmPlan {
  readonly firecrackerBin: string;
  readonly kernelPath: string;
  readonly systemDrivePath: string;
  readonly paths: ImpPaths;
  readonly address: SlotAddress;
  readonly impId: string;
  readonly hostname: string;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly dns: readonly string[];
}

interface StartedVm {
  readonly pid: number;
  readonly firecrackerVersion: string;

  // the protocol version the agent's ping reports
  readonly agentVersion: string;

  // milliseconds per step, for the create-time breakdown in the log
  readonly timings: Readonly<Record<string, number>>;
}

interface WakePlan {
  readonly firecrackerBin: string;
  readonly paths: ImpPaths;
}

// Firecracker, behind an interface so the lifecycle can run against a fake.
export interface VmRunner {
  readonly startVm: (plan: VmPlan) => Promise<StartedVm>;

  // pause, snapshot to new files, kill, rename them into place
  // (docs/architecture/sleep-and-wake.md#sleep); a failed snapshot keeps the VM
  readonly sleepVm: (pid: number, paths: ImpPaths) => Promise<Readonly<Record<string, number>>>;

  // a new Firecracker that loads the snapshot as its first call; throws, with
  // the process gone, when the load or the agent fails
  readonly wakeVm: (plan: WakePlan) => Promise<StartedVm>;

  // agent shutdown first when `graceful`, SIGKILL after the timeout
  readonly stopVm: (pid: number, paths: ImpPaths, graceful: boolean) => Promise<void>;
  readonly isVmAlive: (pid: number, paths: ImpPaths) => boolean;
  readonly isAgentReady: (paths: ImpPaths) => Promise<boolean>;

  // the guest's uptime from the agent's ping, without the time asleep; null
  // when the agent does not answer within 250 ms or cannot read its clock
  readonly readGuestUptimeMs: (paths: ImpPaths) => Promise<number | null>;

  // a live VM after its disk file grew: Firecracker rereads the size, then
  // the guest grows its filesystem into it
  readonly growDrive: (paths: ImpPaths, diskBytes: number) => Promise<void>;
}

// The kernel cmdline: the system drive (vdb) is the initial root and the
// agent PID 1; imp.* parameters configure the guest (DESIGN 2.3).
export function buildBootArgs(plan: Readonly<VmPlan>): string {
  return [
    'console=ttyS0 reboot=k panic=1 pci=off',
    'i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd',
    'root=/dev/vdb rootfstype=squashfs ro init=/imp-agent',
    `imp.id=${plan.impId}`,
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
      const timer = createMarks();
      const setMark = timer.setMark;

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

        await api.putBalloon({
          amountMib: 0,
          deflateOnOom: true,
          statsPollingIntervalS: 1,
          freePageReporting: true,
        });

        const firecrackerVersion = await versionPromise;

        setMark('configure');

        await api.instanceStart();

        setMark('instanceStart');

        const ping = await waitForAgent(plan.paths.vsockSocket, { deadlineMs: AGENT_DEADLINE_MS });

        setMark('agent');

        return { pid, firecrackerVersion, agentVersion: ping.version, timings: timer.marks };
      } catch (error) {
        stopProcess(pid, 'SIGKILL');

        const reason = readErrorMessage(error);

        throw new Error(`boot failed: ${reason}\n${readLogTail(plan.paths.logFile)}`, {
          cause: error,
        });
      }
    },
    sleepVm: async (pid, paths) => {
      const timer = createMarks();
      const setMark = timer.setMark;
      const api = createFirecrackerClient(paths.apiSocket);
      const files = { snapshotPath: `${paths.vmstate}.new`, memFilePath: `${paths.memFile}.new` };

      mkdirSync(paths.snapshotDir, { recursive: true });
      rmSync(files.snapshotPath, { force: true });
      rmSync(files.memFilePath, { force: true });

      // a pause that times out may still land: resume or kill either way
      try {
        await api.pause();

        setMark('pause');

        await api.createSnapshot(files);
      } catch (error) {
        rmSync(files.snapshotPath, { force: true });
        rmSync(files.memFilePath, { force: true });

        try {
          await api.resume();
        } catch {
          // paused for good: kill it, the caller sees it gone and boots the
          // disk cold next time
          stopProcess(pid, 'SIGKILL');

          await waitForExit(pid, paths.apiSocket, KILL_TIMEOUT_MS);
        }

        throw error;
      }

      setMark('snapshot');

      // the VM is paused and its snapshot is on disk: nothing to shut down
      stopProcess(pid, 'SIGKILL');

      if (!(await waitForExit(pid, paths.apiSocket, KILL_TIMEOUT_MS))) {
        throw new Error(`firecracker ${String(pid)} survived SIGKILL`);
      }

      setMark('kill');

      // never write into the old mem file: a restored VM mapped it MAP_PRIVATE
      renameSync(files.snapshotPath, paths.vmstate);
      renameSync(files.memFilePath, paths.memFile);
      rmSync(paths.apiSocket, { force: true });
      rmSync(paths.vsockSocket, { force: true });

      // zero pages become holes: a 2 GiB file with 300 MiB in use takes 381
      // MiB; the snapshot is good without it, so a failure only costs disk
      const dug = await runCommand(['fallocate', '--dig-holes', paths.memFile]);

      const digStep = dug.exitCode === 0 ? 'digHoles' : 'digHolesFailed';

      setMark(digStep);

      return timer.marks;
    },
    wakeVm: async (plan) => {
      const timer = createMarks();
      const setMark = timer.setMark;

      // startFirecracker removes the stale vsock socket, which would end the load
      const pid = await startFirecracker(plan.firecrackerBin, plan.paths);

      setMark('spawn');

      try {
        const api = createFirecrackerClient(plan.paths.apiSocket);

        await api.loadSnapshot(
          { snapshotPath: plan.paths.vmstate, memFilePath: plan.paths.memFile },
          true,
        );

        setMark('load');

        // a ping sent while the guest resumes can hang: retry it soon
        const ping = await waitForAgent(plan.paths.vsockSocket, {
          deadlineMs: WAKE_AGENT_DEADLINE_MS,
          attemptMs: 200,
        });

        setMark('agent');

        await sendResumed(plan.paths.vsockSocket, Date.now());

        const firecrackerVersion = await api.getVersion();

        setMark('resumed');

        return { pid, firecrackerVersion, agentVersion: ping.version, timings: timer.marks };
      } catch (error) {
        stopProcess(pid, 'SIGKILL');

        await waitForExit(pid, plan.paths.apiSocket, KILL_TIMEOUT_MS);

        const reason = readErrorMessage(error);

        throw new Error(`wake failed: ${reason}\n${readLogTail(plan.paths.logFile, 5)}`, {
          cause: error,
        });
      }
    },
    stopVm,
    growDrive: async (paths, diskBytes) => {
      await createFirecrackerClient(paths.apiSocket).patchDrive('rootfs', paths.disk);
      await sendGrow(paths.vsockSocket, diskBytes);
    },
    isVmAlive: (pid, paths) => isFirecrackerAlive(pid, paths.apiSocket),
    isAgentReady: async (paths) => {
      try {
        await waitForAgent(paths.vsockSocket, { deadlineMs: 2000 });

        return true;
      } catch {
        return false;
      }
    },
    readGuestUptimeMs: async (paths) => {
      try {
        const ping = await sendPing(paths.vsockSocket, UPTIME_PING_TIMEOUT_MS);

        return ping.uptime_ms ?? null;
      } catch {
        return null;
      }
    },
  };
}

// milliseconds per step, for the timing breakdown in the log
function createMarks() {
  const marks: Record<string, number> = {};
  let last = performance.now();

  const setMark = (step: string): void => {
    const now = performance.now();

    marks[step] = Math.round(now - last);
    last = now;
  };

  return { marks, setMark };
}
