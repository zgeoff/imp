import { availableParallelism } from 'node:os';
import type { EgressPolicy } from '@imp/api';
import type { Config } from '../config';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { EventBus } from '../events/event-bus';
import type { RamAdmission } from '../governor/ram-governor';
import type { ImageService } from '../images/image-service';
import { deriveSlotAddress } from '../net/addressing';
import type { SlotAddress } from '../net/addressing';
import type { Ipv6Plan } from '../net/ipv6-plan';
import { readGuestNetBytes } from '../net/tap-bytes';
import type { TapDevices } from '../net/tap-devices';
import { printLog } from '../process/print-log';
import { createSessionCache } from '../sessions/session-cache';
import type { SessionCache } from '../sessions/session-cache';
import type { HostIdentity } from '../sleep/vm-identity';
import type { ImpPaths } from '../storage/data-layout';
import { createDiskBudget } from '../storage/disk-budget';
import type { DiskBudget } from '../storage/disk-budget';
import type { CachedDiskUsage } from '../storage/disk-usage-cache';
import type { StorageBackend } from '../storage/storage-backend';
import { createStorageGate } from '../storage/storage-gate';
import type { StorageGate } from '../storage/storage-gate';
import { createBootTemplates } from '../templates/boot-templates';
import type { BootTemplates } from '../templates/boot-templates';
import { createCpuCgroups } from '../vmm/cpu-cgroups';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import type { VmRunner } from '../vmm/vm-runner';
import { readCpuTicks, readOwnedRamMib, readRssMib, readVmMemory } from '../vmm/vm-stats';
import { createActivityTracker } from './activity-tracker';
import type { ActivityTracker } from './activity-tracker';
import { growFilesystem } from './imp-disk';
import { createResourceSampler } from './resource-sampler';
import type { ResourceSampler } from './resource-sampler';

// The egress firewall's part in an imp's life (egress/egress-service.ts)
interface ImpEgress {
  readonly requirePolicy: (policy: EgressPolicy) => void;
  readonly requireImp: (impId: string) => Promise<void>;
  readonly addSlot: (slot: number) => Promise<void>;
  readonly releaseSlot: (slot: number) => Promise<void>;
}

// tests and a host without the firewall: nothing to program
const NO_EGRESS: ImpEgress = {
  requirePolicy: () => {},
  requireImp: () => Promise.resolve(),
  addSlot: () => Promise.resolve(),
  releaseSlot: () => Promise.resolve(),
};

export interface ImpServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly images: ImageService;
  readonly taps: TapDevices;
  readonly vms: VmRunner;
  readonly storage: StorageBackend;
  readonly log?: (message: string) => void;

  // the RAM governor; without one every boot is admitted
  readonly admission?: RamAdmission;

  // what this host boots imps with, which a snapshot must match to load
  readonly identity: HostIdentity;

  // the IPv6 impd resolved at start; null or left out, imps get none
  readonly ipv6?: Ipv6Plan | null;
  readonly readRamMib?: (pid: number, apiSocket: string) => number | null;
  readonly readRssMib?: (pid: number, apiSocket: string) => number | null;

  // the host's live tailnet name, null when tailscaled does not answer; the
  // configured name can be taken by an older node (`imp-1`)
  readonly readTailnetHostname?: () => Promise<string | null>;

  // the imp's own tailnet name as a URL, once impd serves it
  readonly readServiceUrl?: (name: string) => string | null;

  // where lifecycle events go; a bus of its own by default
  readonly events?: EventBus;

  // the clock holds and RAM reservations are judged by; Date.now by default,
  // so tests can move it
  readonly now?: () => number;

  // `KEY=VALUE` entries every exec in the imp starts with, under the
  // caller's own: the credential broker's proxy and CA variables
  readonly readExecEnv?: (imp: ImpRecord, vsockPath: string) => Promise<readonly string[]>;

  // every imp operation joins it under the imp's lock (storage-gate.ts)
  readonly storageGate?: StorageGate;

  // creates, resizes, boots and wakes need room past the reserve; a sleep
  // holds room for its memory file while it writes
  readonly diskBudget?: DiskBudget;

  // the last usage pass's numbers for an imp (disk-usage-cache.ts)
  readonly readDiskUsage?: (impId: string) => CachedDiskUsage | undefined;

  // grows a disk's filesystem on the host while no VM has it open; false
  // leaves the grow to the guest's next boot (imp-disk.ts)
  readonly growFilesystem?: (disk: string) => Promise<boolean>;
  readonly egress?: ImpEgress;

  // each VM's CPU limit; none enforced by default, as outside a container
  readonly cgroups?: CpuCgroups;

  // the most a CPU limit may be; the host's cores by default
  readonly hostCpus?: number;

  // the boot templates cold boots restore (docs/architecture/boot-templates.md);
  // by default made from the deps when IMP_BOOT_TEMPLATES is on
  readonly templates?: BootTemplates | null;
}

// What every part of the imp service shares: the deps with their defaults
// filled in, and the small lookups each part needs.
export interface ImpContext {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly images: ImageService;
  readonly taps: TapDevices;
  readonly vms: VmRunner;
  readonly storage: StorageBackend;
  readonly log: (message: string) => void;
  readonly admission: RamAdmission | undefined;
  readonly readRamMib: (pid: number, apiSocket: string) => number | null;
  readonly readRssMib: (pid: number, apiSocket: string) => number | null;
  readonly readTailnetHostname: (() => Promise<string | null>) | undefined;
  readonly readServiceUrl: (name: string) => string | null;
  readonly now: () => number;
  readonly readExecEnv: (imp: ImpRecord, vsockPath: string) => Promise<readonly string[]>;
  readonly growFilesystem: (disk: string) => Promise<boolean>;
  readonly storageGate: StorageGate;
  readonly diskBudget: DiskBudget;
  readonly readDiskUsage: (impId: string) => CachedDiskUsage | undefined;
  readonly identity: HostIdentity;
  readonly tracker: ActivityTracker;
  readonly sessions: SessionCache;
  readonly findPaths: (impId: string) => ImpPaths;
  readonly findAddress: (slot: number) => SlotAddress;
  readonly egress: ImpEgress;
  readonly cgroups: CpuCgroups;
  readonly hostCpus: number;

  // null when IMP_BOOT_TEMPLATES is off: every cold boot boots the kernel
  readonly templates: BootTemplates | null;

  // the latest look at each running VM (resource-sampler.ts)
  readonly resources: ResourceSampler;
}

export function createImpContext(deps: ImpServiceDeps): ImpContext {
  const slotPlan = {
    subnet: deps.config.subnet,
    portBase: deps.config.portBase,
    prefix6: deps.ipv6?.prefix ?? null,
  };

  const log = deps.log ?? printLog;
  const cgroups = deps.cgroups ?? createCpuCgroups({ root: '/nonexistent', log });
  const readRam = deps.readRamMib;
  const readRss = deps.readRssMib;

  // a test's readers stand in for smaps_rollup; impd reads it once for both
  const readMemory =
    readRam === undefined && readRss === undefined
      ? readVmMemory
      : (pid: number, apiSocket: string) => ({
          ramMib: (readRam ?? readOwnedRamMib)(pid, apiSocket),
          rssMib: (readRss ?? readRssMib)(pid, apiSocket),
        });

  return {
    config: deps.config,
    db: deps.db,
    images: deps.images,
    taps: deps.taps,
    vms: deps.vms,
    storage: deps.storage,
    log,
    admission: deps.admission,
    readRamMib: deps.readRamMib ?? readOwnedRamMib,
    readRssMib: deps.readRssMib ?? readRssMib,
    readTailnetHostname: deps.readTailnetHostname,
    readServiceUrl: deps.readServiceUrl ?? (() => null),
    now: deps.now ?? Date.now,
    readExecEnv: deps.readExecEnv ?? (() => Promise.resolve([])),
    growFilesystem: deps.growFilesystem ?? growFilesystem,
    readDiskUsage: deps.readDiskUsage ?? (() => {}),
    storageGate: deps.storageGate ?? createStorageGate(),
    diskBudget:
      deps.diskBudget ??
      createDiskBudget({
        storage: deps.storage,
        reserveBytes: deps.config.diskReserveBytes,
        log: deps.log ?? printLog,
      }),
    identity: deps.identity,
    tracker: createActivityTracker(),
    sessions: createSessionCache(),
    findPaths: (impId) => deps.storage.resolveImpPaths(impId),
    findAddress: (slot) => deriveSlotAddress(slot, slotPlan),
    egress: deps.egress ?? NO_EGRESS,
    cgroups,
    hostCpus: deps.hostCpus ?? availableParallelism(),
    templates: deps.templates === undefined ? createDefaultTemplates(deps, log) : deps.templates,
    resources: createResourceSampler({
      now: deps.now ?? Date.now,
      readCpuStat: cgroups.readCpuStat,
      readCpuTicks,
      readNetBytes: (tap) => readGuestNetBytes(tap),
      readMemory,
    }),
  };
}

function createDefaultTemplates(
  deps: Readonly<ImpServiceDeps>,
  log: (message: string) => void,
): BootTemplates | null {
  if (!deps.config.bootTemplates) {
    return null;
  }

  return createBootTemplates({
    dataDir: deps.config.dataDir,
    identity: deps.identity,
    firecrackerBin: deps.config.firecrackerBin,
    kernelPath: deps.config.kernelPath,
    minGuestUptimeMs: deps.config.sleepMinGuestUptimeMs,
    bootReservePercent: deps.config.bootReservePercent,
    buildVm: deps.vms.buildTemplateVm,
    taps: deps.taps,
    admission: deps.admission,
    log,
  });
}
