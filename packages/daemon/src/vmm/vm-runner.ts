import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { sendGrow, sendPing, sendResumed, sendShutdown } from '../agent-client/agent-requests';
import { waitForAgent } from '../agent-client/wait-for-agent';
import type { SlotAddress } from '../net/addressing';
import { GATEWAY_IP6 } from '../net/addressing6';
import { runCommand } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import type { ImpPaths, SnapshotPaths } from '../storage/data-layout';
import { writeToDisk } from '../storage/write-file-durably';
import { BASE_BOOT_ARGS, VM_DEVICES, createMarks, setupVm } from './configure-vm';
import type { ImpCgroup } from './cpu-cgroups';
import { createFirecrackerClient } from './firecracker-client';
import type { InstanceState } from './firecracker-client';
import type { FoundVm, VmOwner } from './firecracker-process';
import {
  buildFirecrackerCommand,
  isFirecrackerAlive,
  listFirecrackers,
  readLogTail,
  readPidFile,
  readVmOwner,
  startFirecracker,
  stopProcess,
  waitForExit,
} from './firecracker-process';
import { setupSnapshotFile } from './jail';
import type { JailUser, Jails } from './jail';
import { buildTemplateVm, loadTemplateVm } from './template-vm';
import type { TemplateBuildPlan, TemplateRestorePlan } from './template-vm';
import { createOwnedFile } from './vm-files';

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

  // the imp's jail user; null runs Firecracker unjailed, as root
  readonly jail: JailUser | null;
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

  // the guest's boot_id; absent from an agent from before output offsets
  readonly bootId?: string | undefined;
}

interface WakePlan {
  readonly firecrackerBin: string;
  readonly paths: ImpPaths;
  readonly cgroup: ImpCgroup | null;
  readonly jail: JailUser | null;

  // the files the snapshot's VM reads: the system drive
  readonly readOnlyFiles: readonly string[];
}

// what the rest of a wake learned about the VM
interface FinishedWake {
  readonly agentVersion: string;
  readonly firecrackerVersion: string;
  readonly bootId?: string | undefined;
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

  // agent shutdown first when `graceful`, SIGKILL after the timeout; its
  // jail's mounts go once it has exited
  readonly stopVm: (pid: number, paths: ImpPaths, graceful: boolean) => Promise<void>;

  // the jail's mounts of a VM that exited by itself
  readonly releaseVm: (paths: ImpPaths) => Promise<void>;

  // a destroyed imp's jail, mounts and directory
  readonly removeJail: (paths: ImpPaths) => Promise<void>;

  // the jails of imps not in `impIds`, as after destroys while impd was
  // down; returns their ids
  readonly removeOrphanJails: (impIds: ReadonlySet<string>) => Promise<string[]>;
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
  readonly resumeVm: (pid: number, paths: ImpPaths) => Promise<void>;

  // the pid file a start writes, and every live Firecracker: a start cut
  // short may have left a VM without the file. Either can name a process a
  // jailed VM forged: its owner says whose it is.
  readonly readPid: (paths: ImpPaths) => number | null;
  readonly listVms: () => readonly FoundVm[];
  readonly readVmOwner: (pid: number) => VmOwner;

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
    ...BASE_BOOT_ARGS,
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

// `jails` releases a jail whatever started the VM: an impd with the jailer
// off still stops a jailed VM it adopted. Every Firecracker, an imp's or a
// template build's, starts through `mergeWrapper` (ksm-exec with IMP_KSM).
export function createVmRunner(jails: Jails, mergeWrapper: string | null = null): VmRunner {
  const removeVmMounts = (paths: ImpPaths): Promise<void> => jails.release(paths.impId);

  // the jailer's command in a prepared chroot, or Firecracker's own beside
  // a swept run/
  const buildCommand = async (
    bin: string,
    paths: ImpPaths,
    jail: JailUser | null,
    readOnlyFiles: readonly string[],
  ): Promise<readonly string[]> => {
    if (jail !== null) {
      return jails.prepare({ impId: paths.impId, user: jail, paths, readOnlyFiles });
    }

    await jails.sweepRunDir(paths);

    return buildFirecrackerCommand(bin, paths.apiSocket);
  };

  // a prepare or spawn that fails leaves no jail mounts behind
  const startVmProcess = async (
    command: () => Promise<readonly string[]>,
    paths: ImpPaths,
    cgroup: ImpCgroup | null,
  ): Promise<number> => {
    try {
      const argv = await command();

      return await startFirecracker(argv, paths, cgroup?.procsPath ?? null, mergeWrapper);
    } catch (error) {
      await removeVmMounts(paths);

      throw error;
    }
  };

  // the VM is gone: its jail's mounts can go
  const stopVmNow = async (pid: number, paths: ImpPaths): Promise<boolean> => {
    stopProcess(pid, 'SIGKILL');

    const exited = await waitForExit(pid, paths.apiSocket, KILL_TIMEOUT_MS);

    if (exited) {
      await removeVmMounts(paths);
    }

    return exited;
  };

  const stopVm = async (pid: number, paths: ImpPaths, graceful: boolean): Promise<void> => {
    if (!isFirecrackerAlive(pid, paths.apiSocket)) {
      await removeVmMounts(paths);

      return;
    }

    if (graceful) {
      try {
        await sendShutdown(paths.vsockSocket);

        const exited = await waitForExit(pid, paths.apiSocket, SHUTDOWN_TIMEOUT_MS);

        if (exited) {
          await removeVmMounts(paths);

          return;
        }
      } catch {
        // the agent is gone or hung; kill below
      }
    }

    const killed = await stopVmNow(pid, paths);

    if (!killed) {
      throw new Error(`firecracker ${String(pid)} survived SIGKILL`);
    }
  };

  return {
    startVm: async (plan) => {
      const timer = createMarks();
      const setMark = timer.setMark;

      const buildArgv = () =>
        buildCommand(plan.firecrackerBin, plan.paths, plan.jail, [
          plan.kernelPath,
          plan.systemDrivePath,
        ]);

      const pid = await startVmProcess(buildArgv, plan.paths, plan.cgroup);

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

        jails.seal(plan.paths, pid);

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
          bootId: ping.boot_id,
        };
      } catch (error) {
        await stopVmNow(pid, plan.paths);

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

      // the VM writes into files impd made, owned like its disk
      const owner = lstatSync(paths.disk);

      mkdirSync(target.snapshotDir, { recursive: true });
      createOwnedFile(files.snapshotPath, owner);
      createOwnedFile(files.memFilePath, owner);
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
          await stopVmNow(pid, paths);
        }

        throw error;
      }

      setMark('snapshot');

      // the VM is paused and its snapshot is on disk: nothing to shut down
      if (!(await stopVmNow(pid, paths))) {
        throw new Error(`firecracker ${String(pid)} survived SIGKILL`);
      }

      setMark('kill');

      // nothing of the VM runs now: its files go back to impd before any load
      for (const file of [files.snapshotPath, files.memFilePath]) {
        setupSnapshotFile(file, owner.gid);
      }

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
      const buildArgv = () =>
        buildCommand(plan.firecrackerBin, plan.paths, plan.jail, plan.readOnlyFiles);

      const pid = await startVmProcess(buildArgv, plan.paths, plan.cgroup).catch(
        (error: unknown) => {
          plan.cgroup?.applyLimit();
          throw error;
        },
      );

      setMark('spawn');

      try {
        const api = createFirecrackerClient(plan.paths.apiSocket);

        // the load binds the vsock socket; the seal comes before the guest runs
        await api.loadSnapshot(
          { snapshotPath: plan.paths.vmstate, memFilePath: plan.paths.memFile },
          { resumeVm: false },
        );

        jails.seal(plan.paths, pid);

        await api.resume();

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

        return {
          pid,
          firecrackerVersion,
          agentVersion: ping.version,
          timings: timer.marks,
          bootId: ping.boot_id,
        };
      } catch (error) {
        await stopVmNow(pid, plan.paths);

        plan.cgroup?.applyLimit();
        const reason = readErrorMessage(error);

        throw new Error(`wake failed: ${reason}\n${readLogTail(plan.paths.logFile, 5)}`, {
          cause: error,
        });
      }
    },
    stopVm,
    releaseVm: removeVmMounts,
    removeJail: (paths) => jails.remove(paths.impId),
    removeOrphanJails: jails.removeOrphans,
    growDrive: async (paths, diskBytes) => {
      await createFirecrackerClient(paths.apiSocket).patchDrive(
        VM_DEVICES.drives.rootfs,
        paths.disk,
      );

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
    resumeVm: async (pid, paths) => {
      // a wake cut short between the load and its seal: seal before the guest
      // runs, and kill a VM that left anything in run/
      try {
        jails.seal(paths, pid);
      } catch (error) {
        await stopVmNow(pid, paths);

        throw error;
      }

      await createFirecrackerClient(paths.apiSocket).resume();
    },
    readPid: (paths) => readPidFile(paths.pidFile),
    listVms: listFirecrackers,
    readVmOwner,
    finishWake: async (paths) => {
      const ping = await waitForAgent(paths.vsockSocket, {
        deadlineMs: WAKE_AGENT_DEADLINE_MS,
        attemptMs: 200,
      });

      await sendResumed(paths.vsockSocket, Date.now());

      const firecrackerVersion = await createFirecrackerClient(paths.apiSocket).getVersion();

      return { agentVersion: ping.version, firecrackerVersion, bootId: ping.boot_id };
    },
    buildTemplateVm: (plan) => buildTemplateVm(plan, jails, mergeWrapper),
    loadTemplateVm: (plan) => loadTemplateVm(plan, jails, mergeWrapper),
  };
}
