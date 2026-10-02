import { mkdirSync, rmSync } from 'node:fs';
import { sendClaim, sendPing } from '../agent-client/agent-requests';
import type { Claim } from '../agent-client/agent-requests';
import { waitForAgent } from '../agent-client/wait-for-agent';
import { readErrorMessage } from '../read-error-message';
import { waitForGuestAge } from '../sleep/guest-age';
import { writeToDisk } from '../storage/write-file-durably';
import { createMarks, setupVm } from './configure-vm';
import type { ImpCgroup } from './cpu-cgroups';
import { createFirecrackerClient } from './firecracker-client';
import { readLogTail, startFirecracker, stopProcess, waitForExit } from './firecracker-process';
import type { FirecrackerPaths } from './firecracker-process';
import type { StartedVm } from './vm-runner';

const AGENT_DEADLINE_MS = 15_000;
const KILL_TIMEOUT_MS = 3000;

// the stage-2 ping after a claim: a cold boot's stage 2, without the kernel
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

  // the clock is stamped at the claim, after the load
  readonly claim: Omit<Claim, 'unixMs'>;
}

// Boots the stub VM, waits for stage 1 to park and the guest to be old
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

// Loads the template paused, points its rootfs at the imp's disk (the
// config change is how the guest learns the disk's size), resumes it and
// claims it. The process is gone when any step fails.
export async function loadTemplateVm(plan: Readonly<TemplateRestorePlan>): Promise<StartedVm> {
  const marks = createMarks();

  // startFirecracker puts the process in the cgroup before the load
  const pid = await startFirecracker(
    plan.firecrackerBin,
    plan.paths,
    plan.cgroup?.procsPath ?? null,
  );

  marks.setMark('spawn');

  try {
    const api = createFirecrackerClient(plan.paths.apiSocket);

    await api.loadSnapshot(
      { snapshotPath: plan.vmstate, memFilePath: plan.memFile },
      {
        resumeVm: false,
        overrides: { hostDevName: plan.tap, vsockPath: plan.paths.vsockSocket },
      },
    );

    marks.setMark('load');

    await api.patchDrive('rootfs', plan.diskPath);

    marks.setMark('patch');

    await api.resume();

    marks.setMark('resume');

    await waitForAgent(plan.paths.vsockSocket, {
      deadlineMs: AGENT_DEADLINE_MS,
      attemptMs: 200,
      maxDelayMs: RESTORE_PING_DELAY_MS,
      isParked: true,
    });

    marks.setMark('parked');

    await sendClaim(plan.paths.vsockSocket, { ...plan.claim, unixMs: Date.now() });

    marks.setMark('claim');

    const ping = await waitForAgent(plan.paths.vsockSocket, {
      deadlineMs: CLAIMED_AGENT_DEADLINE_MS,
      maxDelayMs: RESTORE_PING_DELAY_MS,
      isParked: false,
    });

    marks.setMark('stage2');

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

    throw new Error(
      `template restore failed: ${readErrorMessage(error)}\n${readLogTail(plan.paths.logFile, 5)}`,
      { cause: error },
    );
  }
}
