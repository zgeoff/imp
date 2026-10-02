import { mkdirSync, rmSync } from 'node:fs';
import { sendClaim, sendPing } from '../agent-client/agent-requests';
import type { Claim } from '../agent-client/agent-requests';
import { waitForAgent } from '../agent-client/wait-for-agent';
import { readErrorMessage } from '../read-error-message';
import { waitForGuestAge } from '../sleep/guest-age';
import { writeToDisk } from '../storage/write-file-durably';
import { VM_DEVICES, createMarks, setupVm } from './configure-vm';
import type { ImpCgroup } from './cpu-cgroups';
import { createFirecrackerClient } from './firecracker-client';
import { readLogTail, startFirecracker, stopProcess, waitForExit } from './firecracker-process';
import type { FirecrackerPaths } from './firecracker-process';
import type { StartedVm } from './vm-runner';

const AGENT_DEADLINE_MS = 15_000;
const KILL_TIMEOUT_MS = 3000;

// the ping after a claim: the rest of a cold boot, without the kernel
const CLAIMED_AGENT_DEADLINE_MS = 10_000;

// a restore's agent answers within tens of ms: ping often, not on a
// cold boot's backoff
const RESTORE_PING_DELAY_MS = 5;

// The cold boot a template is made from (docs/architecture/boot-templates.md).
export interface TemplateBuildPlan {
  readonly firecrackerBin: string;
  readonly kernelPath: string;
  readonly systemDrivePath: string;
  readonly bootArgs: string;
  readonly vcpus: number;
  readonly memoryMib: number;

  // the template's own sockets and log, and its stand-in for an imp disk
  readonly paths: FirecrackerPaths;
  readonly placeholderPath: string;
  readonly tap: string;
  readonly guestMac: string;

  // IMP_SLEEP_MIN_GUEST_UPTIME_MS: a younger guest restores slowly on a
  // host kernel before 6.7
  readonly minGuestUptimeMs: number;

  // where the snapshot goes; the caller renames the directory into place
  readonly snapshotDir: string;
  readonly vmstate: string;
  readonly memFile: string;
}

// One imp's restore of a template.
export interface TemplateRestorePlan {
  readonly firecrackerBin: string;
  readonly paths: FirecrackerPaths;
  readonly vmstate: string;
  readonly memFile: string;

  // the imp's disk, by its absolute path, and its tap
  readonly diskPath: string;
  readonly tap: string;
  readonly cgroup: ImpCgroup | null;

  // the disk's size once the host has made it: the restore runs up to the
  // parked guest meanwhile, and points rootfs at the disk only then
  readonly diskReady: Promise<number>;

  // the clock is stamped at the claim, after the load
  readonly claim: Omit<Claim, 'unixMs' | 'diskBytes'>;
}

// Boots the stub VM, waits for its agent to park and the guest to be old
// enough, then pauses it and writes a full snapshot. The VM is gone after,
// whatever happens.
export async function buildTemplateVm(plan: Readonly<TemplateBuildPlan>): Promise<void> {
  const pid = await startFirecracker(plan.firecrackerBin, plan.paths);

  try {
    const api = createFirecrackerClient(plan.paths.apiSocket);

    await setupVm(api, {
      kernelPath: plan.kernelPath,
      bootArgs: plan.bootArgs,
      vcpus: plan.vcpus,
      memoryMib: plan.memoryMib,
      diskPath: plan.placeholderPath,
      systemDrivePath: plan.systemDrivePath,
      vsockPath: plan.paths.vsockSocket,
      tap: plan.tap,
      guestMac: plan.guestMac,
    });

    await api.instanceStart();

    await waitForAgent(plan.paths.vsockSocket, {
      deadlineMs: AGENT_DEADLINE_MS,
      isParked: true,
    });

    await waitForGuestAge({
      readUptimeMs: async () => {
        const ping = await sendPing(plan.paths.vsockSocket);

        return ping.uptime_ms ?? null;
      },
      minUptimeMs: plan.minGuestUptimeMs,
      isWanted: () => Promise.resolve(true),
    });

    await api.pause();

    mkdirSync(plan.snapshotDir, { recursive: true });

    await api.createSnapshot({ snapshotPath: plan.vmstate, memFilePath: plan.memFile });

    writeToDisk([plan.vmstate, plan.memFile, plan.snapshotDir]);
  } catch (error) {
    rmSync(plan.snapshotDir, { recursive: true, force: true });

    throw new Error(
      `template build failed: ${readErrorMessage(error)}\n${readLogTail(plan.paths.logFile)}`,
      { cause: error },
    );
  } finally {
    stopProcess(pid, 'SIGKILL');

    await waitForExit(pid, plan.paths.apiSocket, KILL_TIMEOUT_MS);
  }
}

// A failed restore. `isTemplateFault` when the step that failed reads only
// the template: the load, the resume and the parked guest's ping. The disk,
// the patch, the claim and the boot after it are the imp's own.
export class TemplateRestoreError extends Error {
  readonly isTemplateFault: boolean;

  constructor(message: string, isTemplateFault: boolean, cause: unknown) {
    super(message, { cause });

    this.name = 'TemplateRestoreError';
    this.isTemplateFault = isTemplateFault;
  }
}

// Loads the template, resumes it, and once the imp's disk is ready points
// rootfs at it and claims the guest. The process is gone when any step fails.
export async function loadTemplateVm(plan: Readonly<TemplateRestorePlan>): Promise<StartedVm> {
  const marks = createMarks();

  // startFirecracker puts the process in the cgroup before the load
  const pid = await startFirecracker(
    plan.firecrackerBin,
    plan.paths,
    plan.cgroup?.procsPath ?? null,
  );

  marks.setMark('spawn');

  const step = { isTemplateFault: true };

  try {
    const api = createFirecrackerClient(plan.paths.apiSocket);

    await api.loadSnapshot(
      { snapshotPath: plan.vmstate, memFilePath: plan.memFile },
      {
        resumeVm: false,
        overrides: {
          ifaceId: VM_DEVICES.iface,
          hostDevName: plan.tap,
          vsockPath: plan.paths.vsockSocket,
        },
      },
    );

    marks.setMark('load');

    await api.resume();

    marks.setMark('resume');

    await waitForAgent(plan.paths.vsockSocket, {
      deadlineMs: AGENT_DEADLINE_MS,
      attemptMs: 200,
      maxDelayMs: RESTORE_PING_DELAY_MS,
      isParked: true,
    });

    marks.setMark('parked');

    // from here on the imp's own disk and values are in play
    step.isTemplateFault = false;

    const diskBytes = await plan.diskReady;

    marks.setMark('disk');

    // the config change is how virtio-blk tells the guest the disk's size;
    // the parked agent waits for it before it touches the disk
    await api.patchDrive(VM_DEVICES.drives.rootfs, plan.diskPath);

    marks.setMark('patch');

    await sendClaim(plan.paths.vsockSocket, { ...plan.claim, diskBytes, unixMs: Date.now() });

    marks.setMark('claim');

    const ping = await waitForAgent(plan.paths.vsockSocket, {
      deadlineMs: CLAIMED_AGENT_DEADLINE_MS,
      maxDelayMs: RESTORE_PING_DELAY_MS,
      isParked: false,
    });

    marks.setMark('agent');

    const firecrackerVersion = await api.getVersion();

    marks.setMark('version');

    return {
      pid,
      firecrackerVersion,
      agentVersion: ping.version,
      timings: marks.marks,
      identityReset: ping.identity_reset,
    };
  } catch (error) {
    stopProcess(pid, 'SIGKILL');

    await waitForExit(pid, plan.paths.apiSocket, KILL_TIMEOUT_MS);

    throw new TemplateRestoreError(
      `template restore failed: ${readErrorMessage(error)}\n${readLogTail(plan.paths.logFile, 5)}`,
      step.isTemplateFault,
      error,
    );
  }
}
