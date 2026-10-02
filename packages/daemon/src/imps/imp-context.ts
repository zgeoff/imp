import type { Config } from '../config';
import type { ImpDatabase } from '../db/open-database';
import type { RamAdmission } from '../governor/ram-governor';
import type { ImageService } from '../images/image-service';
import { deriveSlotAddress } from '../net/addressing';
import type { SlotAddress } from '../net/addressing';
import type { TapDevices } from '../net/tap-devices';
import { printLog } from '../process/print-log';
import type { HostIdentity } from '../sleep/vm-identity';
import { buildImpPaths } from '../storage/data-layout';
import type { ImpPaths } from '../storage/data-layout';
import { createReflinkClone } from '../storage/reflink';
import type { VmRunner } from '../vmm/vm-runner';
import { readOwnedRamMib, readRssMib } from '../vmm/vm-stats';
import { createActivityTracker } from './activity-tracker';
import type { ActivityTracker } from './activity-tracker';

export interface ImpServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly images: ImageService;
  readonly taps: TapDevices;
  readonly vms: VmRunner;
  readonly log?: (message: string) => void;

  // a reflink clone by default; tests on a non-XFS tmpdir copy instead
  readonly cloneDisk?: (source: string, target: string) => Promise<void>;

  // the RAM governor; without one every boot is admitted
  readonly admission?: RamAdmission;

  // what this host boots imps with, which a snapshot must match to load
  readonly identity: HostIdentity;
  readonly readRamMib?: (pid: number, apiSocket: string) => number | null;
  readonly readRssMib?: (pid: number, apiSocket: string) => number | null;

  // after a create or a destroy: the proxy opens or closes the imp's port
  readonly onImpsChanged?: () => void;

  // the host's live tailnet name, null when tailscaled does not answer; the
  // configured name can be taken by an older node (`imp-1`)
  readonly readTailnetHostname?: () => Promise<string | null>;

  // the clock holds and RAM reservations are judged by; Date.now by default,
  // so tests can move it
  readonly now?: () => number;
}

// What every part of the imp service shares: the deps with their defaults
// filled in, and the small lookups each part needs.
export interface ImpContext {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly images: ImageService;
  readonly taps: TapDevices;
  readonly vms: VmRunner;
  readonly log: (message: string) => void;
  readonly cloneDisk: (source: string, target: string) => Promise<void>;
  readonly admission: RamAdmission | undefined;
  readonly readRamMib: (pid: number, apiSocket: string) => number | null;
  readonly readRssMib: (pid: number, apiSocket: string) => number | null;
  readonly readTailnetHostname: (() => Promise<string | null>) | undefined;
  readonly now: () => number;
  readonly identity: HostIdentity;
  readonly emitChanged: () => void;
  readonly tracker: ActivityTracker;
  readonly findPaths: (impId: string) => ImpPaths;
  readonly findAddress: (slot: number) => SlotAddress;
}

export function createImpContext(deps: ImpServiceDeps): ImpContext {
  const slotPlan = { subnet: deps.config.subnet, portBase: deps.config.portBase };

  return {
    config: deps.config,
    db: deps.db,
    images: deps.images,
    taps: deps.taps,
    vms: deps.vms,
    log: deps.log ?? printLog,
    cloneDisk: deps.cloneDisk ?? createReflinkClone,
    admission: deps.admission,
    readRamMib: deps.readRamMib ?? readOwnedRamMib,
    readRssMib: deps.readRssMib ?? readRssMib,
    readTailnetHostname: deps.readTailnetHostname,
    now: deps.now ?? Date.now,
    identity: deps.identity,
    emitChanged: () => {
      deps.onImpsChanged?.();
    },
    tracker: createActivityTracker(),
    findPaths: (impId) => buildImpPaths(deps.config.dataDir, impId),
    findAddress: (slot) => deriveSlotAddress(slot, slotPlan),
  };
}
