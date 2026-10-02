import { mkdirSync, rmSync } from 'node:fs';
import { sendClaim, sendPing } from '../agent-client/agent-requests';
import type { Claim } from '../agent-client/agent-requests';
import { waitForAgent } from '../agent-client/wait-for-agent';
import { readErrorMessage } from '../read-error-message';
import { waitForGuestAge } from '../sleep/guest-age';
import type { ImpPaths } from '../storage/data-layout';
import { writeToDisk } from '../storage/write-file-durably';
import { VM_DEVICES, createMarks, setupVm } from './configure-vm';
import type { ImpCgroup } from './cpu-cgroups';
import { createFirecrackerClient } from './firecracker-client';
import {
  buildFirecrackerCommand,
  readLogTail,
  startFirecracker,
  stopProcess,
  waitForExit,
} from './firecracker-process';
import { setupTemplateFile } from './jail';
import type { JailUser, Jails, RunPaths } from './jail';
import { createOwnedFile } from './vm-files';
import type { StartedVm } from './vm-runner';

// root in the container: who owns the snapshot files of an unjailed build
const IMPD_USER = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
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

  // the build's work dir, with its sockets and log in run/, and the stand-in
  // for an imp disk, which a jailed build gets as a file of its own
  readonly workDir: string;
  readonly paths: RunPaths;
  readonly placeholderPath: string;
  readonly tap: string;
  readonly guestMac: string;

  // the build's own jail and cgroup; a null jail runs it as root
  readonly jailId: string;
  readonly jail: JailUser | null;
  readonly cgroup: ImpCgroup | null;

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
  readonly paths: ImpPaths;

  // the template's files and the system drive its snapshot names, bound in
  // read-only, and its placeholder disk, a file of the imp's own
  readonly vmstate: string;
  readonly memFile: string;
  readonly systemDrivePath: string;
  readonly placeholderPath: string;

  // the imp's disk, by its absolute path, and its tap
  readonly diskPath: string;
  readonly tap: string;
  readonly cgroup: ImpCgroup | null;
  readonly jail: JailUser | null;

  // the disk's size once the host has made it: the restore runs up to the
  // parked guest meanwhile, and points rootfs at the disk only then
  readonly diskReady: Promise<number>;

  // the clock is stamped at the claim, after the load
  readonly claim: Omit<Claim, 'unixMs' | 'diskBytes'>;
}

// Boots the stub VM, waits for its agent to park and the guest to be old
// enough, then pauses it and writes a full snapshot. The VM and its jail's
// mounts are gone after, whatever happens; the files are root's then.
export async function buildTemplateVm(
  plan: Readonly<TemplateBuildPlan>,
  jails: Jails,
  mergeWrapper: string | null = null,
): Promise<void> {
  try {
    await runBuildVm(plan, jails, mergeWrapper);

    // every restore, of any imp, reads them: root's, and readable by all
    setupTemplateFile(plan.vmstate);
    setupTemplateFile(plan.memFile);
    writeToDisk([plan.vmstate, plan.memFile, plan.snapshotDir]);
  } catch (error) {
    rmSync(plan.snapshotDir, { recursive: true, force: true });

    throw new Error(
      `template build failed: ${readErrorMessage(error)}\n${readLogTail(plan.paths.logFile)}`,
      { cause: error },
    );
  }
}

async function runBuildVm(
  plan: Readonly<TemplateBuildPlan>,
  jails: Jails,
  mergeWrapper: string | null,
): Promise<void> {
  try {
    const argv =
      plan.jail === null
        ? buildFirecrackerCommand(plan.firecrackerBin, plan.paths.apiSocket)
        : await jails.prepareBuild({
            id: plan.jailId,
            user: plan.jail,
            workDir: plan.workDir,
            paths: plan.paths,
            readOnlyFiles: [plan.kernelPath, plan.systemDrivePath],
            scratchFiles: [plan.placeholderPath],
          });

    const pid = await startFirecracker(
      argv,
      plan.paths,
      plan.cgroup?.procsPath ?? null,
      mergeWrapper,
    );

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

      jails.seal(plan.paths, pid);

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

      // the VM writes into files impd made, in a directory it cannot change
      const owner = plan.jail ?? IMPD_USER;

      mkdirSync(plan.snapshotDir, { recursive: true });
      createOwnedFile(plan.vmstate, owner);
      createOwnedFile(plan.memFile, owner);

      await api.createSnapshot({ snapshotPath: plan.vmstate, memFilePath: plan.memFile });
    } finally {
      stopProcess(pid, 'SIGKILL');

      await waitForExit(pid, plan.paths.apiSocket, KILL_TIMEOUT_MS);
    }
  } finally {
    // kills every process of the uid too: nothing writes the files after
    if (plan.jail !== null) {
      await jails.release(plan.jailId);
    }
  }
}

// a prepare or spawn that fails leaves no jail mounts behind
async function startRestoreProcess(
  plan: Readonly<TemplateRestorePlan>,
  jails: Jails,
  mergeWrapper: string | null,
): Promise<number> {
  try {
    const argv = await buildRestoreCommand(plan, jails);

    return await startFirecracker(argv, plan.paths, plan.cgroup?.procsPath ?? null, mergeWrapper);
  } catch (error) {
    await jails.release(plan.paths.impId);

    throw error;
  }
}

// the jailer's command in the imp's chroot with the template bound in, or
// Firecracker's own beside a swept run/
async function buildRestoreCommand(
  plan: Readonly<TemplateRestorePlan>,
  jails: Jails,
): Promise<readonly string[]> {
  if (plan.jail === null) {
    await jails.sweepRunDir(plan.paths);

    return buildFirecrackerCommand(plan.firecrackerBin, plan.paths.apiSocket);
  }

  return jails.prepare({
    impId: plan.paths.impId,
    user: plan.jail,
    paths: plan.paths,
    readOnlyFiles: [plan.vmstate, plan.memFile, plan.systemDrivePath],
    scratchFiles: [plan.placeholderPath],
    isDiskLate: true,
  });
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
export async function loadTemplateVm(
  plan: Readonly<TemplateRestorePlan>,
  jails: Jails,
  mergeWrapper: string | null = null,
): Promise<StartedVm> {
  const marks = createMarks();

  // startFirecracker puts the process in the cgroup before the load
  const pid = await startRestoreProcess(plan, jails, mergeWrapper);

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

    // the load bound the vsock socket; no guest code has run yet
    jails.seal(plan.paths, pid);

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

    // the clone made the disk as root's, after the prepare
    if (plan.jail !== null) {
      jails.setupDiskOwner(plan.paths, plan.jail);
    }

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
      bootId: ping.boot_id,
    };
  } catch (error) {
    stopProcess(pid, 'SIGKILL');

    await waitForExit(pid, plan.paths.apiSocket, KILL_TIMEOUT_MS);

    await jails.release(plan.paths.impId);

    throw new TemplateRestoreError(
      `template restore failed: ${readErrorMessage(error)}\n${readLogTail(plan.paths.logFile, 5)}`,
      step.isTemplateFault,
      error,
    );
  }
}
