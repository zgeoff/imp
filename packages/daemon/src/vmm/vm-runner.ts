import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { sendGrow, sendPing, sendResumed, sendShutdown } from '../agent-client/agent-requests';
import { waitForAgent } from '../agent-client/wait-for-agent';
import type { SlotAddress } from '../net/addressing';
import { GATEWAY_IP6 } from '../net/addressing6';
import { runCommand } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import type { ImpPaths, SnapshotPaths } from '../storage/data-layout';
import { writeToDisk } from '../storage/write-file-durably';
import { createMarks, setupVm } from './configure-vm';
import type { ImpCgroup } from './cpu-cgroups';
import { createFirecrackerClient } from './firecracker-client';
import type { InstanceState } from './firecracker-client';
import {
  isFirecrackerAlive,
  listFirecrackers,
  readLogTail,
  readPidFile,
  startFirecracker,
  stopProcess,
  waitForExit,
} from './firecracker-process';
import { buildTemplateVm, loadTemplateVm } from './template-vm';
import type { TemplateBuildPlan, TemplateRestorePlan } from './template-vm';

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

  // the CPU limit's cgroup; null runs the VM unlimited
  readonly cgroup: ImpCgroup | null;

  // the first boot of an imp from a template: the agent gives it a new
  // machine-id and ssh host keys (docs/guides/templates.md#identity)
  readonly isIdentityReset: boolean;
}

export interface StartedVm {
  readonly pid: number;
  readonly firecrackerVersion: string;

  // the protocol version the agent's ping reports
  readonly agentVersion: string;

  // milliseconds per step, for the create-time breakdown in the log
  readonly timings: Readonly<Record<string, number>>;

  // what a boot with isIdentityReset reported; absent for any other start
  readonly identityReset?: 'ok' | 'failed' | undefined;
}

interface WakePlan {
  readonly firecrackerBin: string;
  readonly paths: ImpPaths;
  readonly cgroup: ImpCgroup | null;
}

// a live Firecracker, by the API socket it serves
interface FoundVm {
  readonly pid: number;
  readonly apiSocket: string;
}

// what the rest of a wake learned about the VM
interface FinishedWake {
  readonly agentVersion: string;
  readonly firecrackerVersion: string;
}

// Firecracker, behind an interface so the lifecycle can run against a fake.
export interface VmRunner {
  readonly startVm: (plan: VmPlan) => Promise<StartedVm>;

  // pause, snapshot to new files in `target`, kill, rename them into place
  // (docs/architecture/sleep-and-wake.md#sleep); a failed snapshot keeps the VM
  readonly sleepVm: (
    pid: number,
    paths: ImpPaths,
    cgroup: ImpCgroup | null,
    target: SnapshotPaths,
  ) => Promise<Readonly<Record<string, number>>>;

  // a new Firecracker that loads the snapshot as its first call; throws, with
  // the process gone, when the load or the agent fails
  readonly wakeVm: (plan: WakePlan) => Promise<StartedVm>;

  // agent shutdown first when `graceful`, SIGKILL after the timeout
  readonly stopVm: (pid: number, paths: ImpPaths, graceful: boolean) => Promise<void>;
  readonly isVmAlive: (pid: number, paths: ImpPaths) => boolean;
  readonly isAgentReady: (paths: ImpPaths, deadlineMs?: number) => Promise<boolean>;

  // the guest's uptime from the agent's ping, without the time asleep; null
  // when the agent does not answer within 250 ms or cannot read its clock
  readonly readGuestUptimeMs: (paths: ImpPaths) => Promise<number | null>;

  // a live VM after its disk file grew: Firecracker rereads the size, then
  // the guest grows its filesystem into it
  readonly growDrive: (paths: ImpPaths, diskBytes: number) => Promise<void>;

  // what the VM behind the API socket does; null when nothing answers
  readonly readVmState: (paths: ImpPaths) => Promise<InstanceState | null>;
  readonly resumeVm: (paths: ImpPaths) => Promise<void>;

  // the pid file a start writes, and every live Firecracker: a start cut
  // short may have left a VM without the file
  readonly readPid: (paths: ImpPaths) => number | null;
  readonly listVms: () => readonly FoundVm[];

  // the rest of a wake, for a VM that loaded its snapshot under an impd that
  // died: the agent's ping, then the guest clock
  readonly finishWake: (paths: ImpPaths) => Promise<FinishedWake>;

  // a boot template: a cold boot parked for a claim, snapshotted and killed
  // (docs/architecture/boot-templates.md#make)
  readonly buildTemplateVm: (plan: TemplateBuildPlan) => Promise<void>;

  // a start from a template, in place of startVm; throws, with the process
  // gone, when any step fails (docs/architecture/boot-templates.md#claim)
  readonly loadTemplateVm: (plan: TemplateRestorePlan) => Promise<StartedVm>;
}

// The kernel cmdline: the system drive (vdb) is the initial root and the agent
// PID 1; imp.* parameters configure the guest
// (docs/architecture/agent.md#two-drives).
export function buildBootArgs(plan: Readonly<VmPlan>): string {
  return [
    'console=ttyS0 reboot=k panic=1 pci=off',
    'i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd',
    'root=/dev/vdb rootfstype=squashfs ro init=/imp-agent',
    `imp.id=${plan.impId}`,
    `imp.hostname=${plan.hostname}`,
    `imp.ip=${plan.address.guestIp}/${String(plan.address.prefixLength)}`,
    `imp.gw=${plan.address.hostIp}`,
    ...(plan.address.guestIp6 === null
      ? []
      : [`imp.ip6=${plan.address.guestIp6}/128`, `imp.gw6=${GATEWAY_IP6}`]),
    `imp.dns=${plan.dns.join(',')}`,
    ...(plan.isIdentityReset ? ['imp.reset_identity=1'] : []),
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

      const pid = await startFirecracker(
        plan.firecrackerBin,
        plan.paths,
        plan.cgroup?.procsPath ?? null,
      );

      setMark('spawn');

      try {
        const api = createFirecrackerClient(plan.paths.apiSocket);
        const versionPromise = api.getVersion();

        await setupVm(api, {
          kernelPath: plan.kernelPath,
          bootArgs: buildBootArgs(plan),
          vcpus: plan.vcpus,
          memoryMib: plan.memoryMib,
          diskPath: plan.paths.disk,
          systemDrivePath: plan.systemDrivePath,
          vsockPath: plan.paths.vsockSocket,
          tap: plan.address.tap,
          guestMac: plan.address.guestMac,
        });

        const firecrackerVersion = await versionPromise;

        setMark('configure');

        await api.instanceStart();

        setMark('instanceStart');

        const ping = await waitForAgent(plan.paths.vsockSocket, { deadlineMs: AGENT_DEADLINE_MS });

        setMark('agent');

        return {
          pid,
          firecrackerVersion,
          agentVersion: ping.version,
          timings: timer.marks,
          identityReset: ping.identity_reset,
        };
      } catch (error) {
        stopProcess(pid, 'SIGKILL');

        // the disk stays open until the process is gone: a retry must not
        // put a second VM on it
        await waitForExit(pid, plan.paths.apiSocket, KILL_TIMEOUT_MS);

        const reason = readErrorMessage(error);

        throw new Error(`boot failed: ${reason}\n${readLogTail(plan.paths.logFile)}`, {
          cause: error,
        });
      }
    },
    sleepVm: async (pid, paths, cgroup, target) => {
      const timer = createMarks();
      const setMark = timer.setMark;
      const api = createFirecrackerClient(paths.apiSocket);
      const files = { snapshotPath: `${target.vmstate}.new`, memFilePath: `${target.memFile}.new` };

      mkdirSync(target.snapshotDir, { recursive: true });
      rmSync(files.snapshotPath, { force: true });
      rmSync(files.memFilePath, { force: true });
      cgroup?.liftLimit();

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

          cgroup?.applyLimit();
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
      renameSync(files.snapshotPath, target.vmstate);
      renameSync(files.memFilePath, target.memFile);
      rmSync(paths.apiSocket, { force: true });
      rmSync(paths.vsockSocket, { force: true });

      // zero pages become holes: a 2 GiB file with 300 MiB in use takes 381
      // MiB; the snapshot is good without it, so a failure only costs disk
      const dug = await runCommand(['fallocate', '--dig-holes', target.memFile]);

      const digStep = dug.exitCode === 0 ? 'digHoles' : 'digHolesFailed';

      setMark(digStep);

      // meta.json, written next, vouches for these: they reach the disk first
      writeToDisk([target.vmstate, target.memFile, target.snapshotDir]);
      setMark('flush');

      return timer.marks;
    },
    wakeVm: async (plan) => {
      const timer = createMarks();
      const setMark = timer.setMark;

      // unlimited until the memory is in and the guest runs again
      plan.cgroup?.liftLimit();

      // startFirecracker removes the stale vsock socket, which would end the load
      const pid = await startFirecracker(
        plan.firecrackerBin,
        plan.paths,
        plan.cgroup?.procsPath ?? null,
      );

      setMark('spawn');

      try {
        const api = createFirecrackerClient(plan.paths.apiSocket);

        await api.loadSnapshot(
          { snapshotPath: plan.paths.vmstate, memFilePath: plan.paths.memFile },
          { resumeVm: true },
        );

        plan.cgroup?.applyLimit();
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
    isAgentReady: async (paths, deadlineMs = 2000) => {
      try {
        await waitForAgent(paths.vsockSocket, { deadlineMs });

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
    readVmState: async (paths) => {
      try {
        return await createFirecrackerClient(paths.apiSocket).getInstanceState();
      } catch {
        return null;
      }
    },
    resumeVm: (paths) => createFirecrackerClient(paths.apiSocket).resume(),
    readPid: (paths) => readPidFile(paths.pidFile),
    listVms: listFirecrackers,
    finishWake: async (paths) => {
      const ping = await waitForAgent(paths.vsockSocket, {
        deadlineMs: WAKE_AGENT_DEADLINE_MS,
        attemptMs: 200,
      });

      await sendResumed(paths.vsockSocket, Date.now());

      const firecrackerVersion = await createFirecrackerClient(paths.apiSocket).getVersion();

      return { agentVersion: ping.version, firecrackerVersion };
    },
    buildTemplateVm,
    loadTemplateVm,
  };
}
