import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import type { RamAdmission } from '../governor/ram-governor';
import { createSemaphore } from '../imps/semaphore';
import type { SlotAddress } from '../net/addressing';
import type { TapDevices } from '../net/tap-devices';
import { runCommand } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import type { HostIdentity } from '../sleep/vm-identity';
import type { DiskBudget } from '../storage/disk-budget';
import { BASE_BOOT_ARGS, VM_DEVICES } from '../vmm/configure-vm';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import type { JailUser } from '../vmm/jail';
import type { TemplateBuildPlan } from '../vmm/template-vm';

// The cmdline of every template: the agent parks for a claim, and nothing in
// it names an imp (docs/architecture/boot-templates.md#make)
const TEMPLATE_BOOT_ARGS = [...BASE_BOOT_ARGS, 'imp.template=1'].join(' ');

// The template VM's own tap: it is only ever opened by a build, one at a
// time, and its guest configures no address. A restore names the imp's tap.
const TEMPLATE_ADDRESS: SlotAddress = {
  slot: -1,
  tap: 'imp-tpl',
  hostIp: '169.254.255.253',
  guestIp: '169.254.255.254',
  prefixLength: 30,
  netmask: '255.255.255.252',
  guestMac: '06:00:a9:fe:ff:fe',
  hostMac: '06:01:a9:fe:ff:fd',
  guestIp6: null,
  tailnetPort: 0,
};

// the jail and cgroup every build runs in, one at a time, with no CPU limit
const BUILD_JAIL_ID = 'tpl-build';
const BUILD_CPU = { limit: null, weight: 100 };
const PLACEHOLDER_BYTES = 1024 * 1024;
const PLACEHOLDER_NAME = 'placeholder.ext4';
const MIB = 1024 * 1024;

// docs/architecture/boot-templates.md#limits has why each is what it is
const MIN_MISSES = 2;
const MAX_TEMPLATES = 4;
const MAX_BUILD_FAILURES = 3;
const MAX_RESTORE_FAILURES = 3;
const BUILD_RETRY_MS = 60_000;

const TemplateMetaSchema = z.object({
  buildId: z.string(),
  vcpus: z.int().positive(),
  memoryMib: z.int().positive(),
  systemDrivePath: z.string(),
});

type TemplateMeta = z.infer<typeof TemplateMetaSchema>;

export interface TemplateShape {
  readonly vcpus: number;
  readonly memoryMib: number;
}

interface TemplateFiles {
  readonly key: string;

  // which build made the files: a key rebuilt after a removal gets a new one
  readonly buildId: string;
  readonly vmstate: string;
  readonly memFile: string;

  // what the snapshot reopens on a restore: the system drive it booted, and
  // the placeholder it saw as its disk
  readonly systemDrivePath: string;
  readonly placeholderPath: string;
}

export interface BootTemplates {
  // the ready template for the shape, or null; the second miss of a key
  // starts its build in the background
  readonly find: (shape: Readonly<TemplateShape>) => TemplateFiles | null;

  // the build itself, shared by every miss of one key while it runs; it
  // rejects while the key backs off or is off
  readonly buildTemplate: (shape: Readonly<TemplateShape>) => Promise<TemplateFiles>;

  // a restore of `files` failed; `isTemplateFault` when it failed before the
  // claim, where nothing of the imp's own was in play: only then do those
  // files go and the failure count toward turning the key off
  readonly reportFailure: (files: Readonly<TemplateFiles>, isTemplateFault: boolean) => void;
  readonly reportRestored: (files: Readonly<TemplateFiles>) => void;

  // drops templates this host no longer boots, and what builds cut short
  // left; returns the keys. At startup only, before any build: a build's
  // work directory counts as left over.
  readonly removeStale: () => string[];

  // the system drives the templates reopen on a restore
  readonly listDrivePaths: () => string[];

  // waits for builds in flight
  readonly stop: () => Promise<void>;
}

export interface BootTemplateDeps {
  readonly dataDir: string;
  readonly identity: HostIdentity;
  readonly firecrackerBin: string;
  readonly kernelPath: string;
  readonly minGuestUptimeMs: number;
  readonly bootReservePercent: number;
  readonly buildVm: (plan: Readonly<TemplateBuildPlan>) => Promise<void>;
  readonly taps: TapDevices;

  // who a build runs as (TEMPLATE_BUILD_UID); null runs it unjailed
  readonly jail: JailUser | null;
  readonly cgroups: Pick<CpuCgroups, 'setup' | 'remove'>;
  readonly admission?: RamAdmission | undefined;
  readonly diskBudget?: Pick<DiskBudget, 'withRoom'> | undefined;
  readonly now?: () => number;
  readonly log: (message: string) => void;
}

// The host had no free RAM or disk room for a build: it backs off, but
// counts as no failure, since a host near its budget is the normal case.
class BuildRefusedError extends Error {
  override name = 'BuildRefusedError';
}

// what a key has cost: failed builds hold off the next one, and too many
// failures of either kind turn the key off until impd restarts
interface KeyRecord {
  misses: number;
  buildFailures: number;
  restoreFailures: number;
  retryAt: number;
  isOff: boolean;
}

// Everything a restore inherits from the snapshot; the drive's sha covers
// the agent, and the image is not in it, since the disk is the imp's own
// (docs/architecture/boot-templates.md#key).
export function buildTemplateKey(identity: Readonly<HostIdentity>, shape: Readonly<TemplateShape>) {
  const fields = {
    guestKernel: identity.guestKernel,
    systemDrive: identity.systemDrive,
    firecrackerVersion: identity.firecrackerVersion,
    snapshotVersion: identity.snapshotVersion,
    hostKernel: identity.hostKernel,

    // the guest kernel picked its code paths on this CPU: one that changed
    // since, as a cloud host's can at a reboot, faults a restore
    cpuModel: identity.cpuModel,
    cpuFlags: identity.cpuFlags,
    bootArgs: TEMPLATE_BOOT_ARGS,
    devices: VM_DEVICES,
    memoryMib: shape.memoryMib,
    vcpus: shape.vcpus,
  };

  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function createBootTemplates(deps: BootTemplateDeps): BootTemplates {
  const root = join(deps.dataDir, 'templates');
  const now = deps.now ?? Date.now;

  // the snapshot names this path, so it is the same for every template
  const placeholder = join(root, PLACEHOLDER_NAME);

  const building = new Map<string, Promise<TemplateFiles>>();
  const records = new Map<string, KeyRecord>();

  // when each template last served a restore; LRU eviction reads it
  const lastUsed = new Map<string, number>();

  // one build at a time: they share the template tap
  const lane = createSemaphore(1);

  const readRecord = (key: string): KeyRecord => {
    const found = records.get(key);

    if (found !== undefined) {
      return found;
    }

    const record = { misses: 0, buildFailures: 0, restoreFailures: 0, retryAt: 0, isOff: false };

    records.set(key, record);

    return record;
  };

  const readMeta = (key: string): TemplateMeta | null => {
    try {
      const text = readFileSync(join(root, key, 'meta.json'), 'utf8');

      return TemplateMetaSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  };

  // the ready template of the key, or null
  const findReady = (key: string): TemplateFiles | null => {
    const dir = join(root, key);
    const meta = readMeta(key);
    const files = { vmstate: join(dir, 'vmstate'), memFile: join(dir, 'mem') };

    if (meta === null || !existsSync(files.vmstate) || !existsSync(files.memFile)) {
      return null;
    }

    return {
      key,
      buildId: meta.buildId,
      ...files,
      systemDrivePath: meta.systemDrivePath,
      placeholderPath: placeholder,
    };
  };

  const listTemplateKeys = (): string[] =>
    existsSync(root)
      ? readdirSync(root).filter((name) => name !== PLACEHOLDER_NAME && !name.startsWith('.'))
      : [];

  // a directory a restore may still map stays readable: rename it away, then
  // remove it; a mapped mem file lives on until its last VM exits
  const removeDir = (name: string): void => {
    const gone = join(root, `.gone-${Bun.randomUUIDv7()}`);

    try {
      renameSync(join(root, name), gone);
    } catch {
      return;
    }

    rmSync(gone, { recursive: true, force: true });

    lastUsed.delete(name);
  };

  const readLastUsed = (key: string): number => {
    const used = lastUsed.get(key);

    if (used !== undefined) {
      return used;
    }

    try {
      return statSync(join(root, key)).mtimeMs;
    } catch {
      return 0;
    }
  };

  // past MAX_TEMPLATES, the least recently used go
  const removeLeastUsed = (keep: string): void => {
    const keys = listTemplateKeys().filter((key) => key !== keep);
    const excess = keys.length + 1 - MAX_TEMPLATES;

    if (excess <= 0) {
      return;
    }

    const byAge = keys.toSorted((a, b) => readLastUsed(a) - readLastUsed(b));

    for (const key of byAge.slice(0, excess)) {
      removeDir(key);

      deps.log(`impd: removed boot template ${key.slice(0, 12)}: least recently used`);
    }
  };

  const writeTemplate = async (
    shape: Readonly<TemplateShape>,
    key: string,
    work: string,
    buildId: string,
  ): Promise<TemplateFiles> => {
    const runDir = join(work, 'run');

    mkdirSync(runDir, { recursive: true });

    if (!existsSync(placeholder)) {
      writeFileSync(placeholder, '');
      truncateSync(placeholder, PLACEHOLDER_BYTES);
    }

    const started = performance.now();

    await deps.taps.setupTap(TEMPLATE_ADDRESS, deps.jail);

    const snapshotDir = join(work, 'snapshot');

    // memory.max caps a build too, and cgroup.kill stops all of it
    const cgroup = deps.cgroups.setup(BUILD_JAIL_ID, BUILD_CPU, shape.memoryMib);

    if (cgroup === null && deps.jail !== null) {
      throw new Error('a jailed template build needs its own cgroup, and it has none');
    }

    try {
      await deps.buildVm({
        firecrackerBin: deps.firecrackerBin,
        kernelPath: deps.kernelPath,
        systemDrivePath: deps.identity.systemDrivePath,
        bootArgs: TEMPLATE_BOOT_ARGS,
        vcpus: shape.vcpus,
        memoryMib: shape.memoryMib,
        workDir: work,
        paths: {
          runDir,
          apiSocket: join(runDir, 'api.sock'),
          vsockSocket: join(runDir, 'vsock.sock'),
          logFile: join(runDir, 'firecracker.log'),
          pidFile: join(runDir, 'pid'),
        },
        placeholderPath: placeholder,
        tap: TEMPLATE_ADDRESS.tap,
        guestMac: TEMPLATE_ADDRESS.guestMac,
        jailId: BUILD_JAIL_ID,
        jail: deps.jail,
        cgroup,
        minGuestUptimeMs: deps.minGuestUptimeMs,
        snapshotDir,
        vmstate: join(snapshotDir, 'vmstate'),
        memFile: join(snapshotDir, 'mem'),
      });
    } finally {
      // logged, never thrown: the build's own error is the one that counts
      await deps.cgroups.remove(BUILD_JAIL_ID).catch((error: unknown) => {
        deps.log(`impd: cgroup ${BUILD_JAIL_ID}: ${readErrorMessage(error)}`);
      });
    }

    // zero pages become holes, before any VM maps the file; never after
    await runCommand(['fallocate', '--dig-holes', join(snapshotDir, 'mem')]);

    const meta: TemplateMeta = {
      buildId,
      ...shape,
      systemDrivePath: deps.identity.systemDrivePath,
    };

    writeFileSync(join(snapshotDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    renameSync(snapshotDir, join(root, key));

    lastUsed.set(key, now());

    removeLeastUsed(key);

    const ms = Math.round(performance.now() - started);

    deps.log(`impd: boot template ${key.slice(0, 12)} built in ${String(ms)}ms`);

    return {
      key,
      buildId,
      vmstate: join(root, key, 'vmstate'),
      memFile: join(root, key, 'mem'),
      systemDrivePath: meta.systemDrivePath,
      placeholderPath: placeholder,
    };
  };

  // A build takes free RAM and holds disk room for its mem file, which can be
  // the whole memory, until the rename; a refusal of either throws a
  // BuildRefusedError.
  const runBuild = async (shape: Readonly<TemplateShape>, key: string): Promise<TemplateFiles> => {
    const work = join(root, `.build-${Bun.randomUUIDv7()}`);
    const id = `template-${key.slice(0, 12)}`;
    const buildId = Bun.randomUUIDv7();
    const progress = { isBuilding: false };

    const writeAdmitted = (): Promise<TemplateFiles> => {
      progress.isBuilding = true;

      return writeTemplate(shape, key, work, buildId);
    };

    try {
      // no user waits on a build: it takes free RAM, never an imp's
      await deps.admission?.admit({
        id,
        name: null,
        reserveMib: Math.ceil((shape.memoryMib * deps.bootReservePercent) / 100),
        memoryMib: shape.memoryMib,
        maySleepImps: false,
      });

      return await (deps.diskBudget === undefined
        ? writeAdmitted()
        : deps.diskBudget.withRoom(shape.memoryMib * MIB, writeAdmitted));
    } catch (error) {
      if (progress.isBuilding) {
        throw error;
      }

      throw new BuildRefusedError(readErrorMessage(error), { cause: error });
    } finally {
      deps.admission?.release(id);
      rmSync(work, { recursive: true, force: true });
    }
  };

  // a failed build holds off the next one, twice as long each time; the
  // third failure turns the key off. A refused build holds off the next one
  // as long as a first failure, and is no failure.
  const setBuildFailed = (key: string, error: unknown): void => {
    const record = readRecord(key);

    if (error instanceof BuildRefusedError) {
      record.retryAt = now() + BUILD_RETRY_MS;

      deps.log(
        `impd: boot template ${key.slice(0, 12)} build refused (next try in ${String(BUILD_RETRY_MS / 1000)}s): ${error.message}`,
      );

      return;
    }

    record.buildFailures += 1;
    record.retryAt = now() + BUILD_RETRY_MS * 2 ** (record.buildFailures - 1);
    record.isOff = record.buildFailures >= MAX_BUILD_FAILURES;

    const next = record.isOff
      ? 'off until impd restarts'
      : `next try in ${String(Math.round((record.retryAt - now()) / 1000))}s`;

    deps.log(
      `impd: boot template ${key.slice(0, 12)} build failed (${next}): ${readErrorMessage(error)}`,
    );
  };

  const buildTemplate = (shape: Readonly<TemplateShape>): Promise<TemplateFiles> => {
    const key = buildTemplateKey(deps.identity, shape);
    const record = readRecord(key);

    if (record.isOff) {
      return Promise.reject(new Error('boot templates of this shape are off until impd restarts'));
    }

    const ready = findReady(key);

    if (ready !== null) {
      return Promise.resolve(ready);
    }

    const inFlight = building.get(key);

    if (inFlight !== undefined) {
      return inFlight;
    }

    if (now() < record.retryAt) {
      return Promise.reject(
        new Error('boot template builds of this shape back off; try again later'),
      );
    }

    const runShared = async (): Promise<TemplateFiles> => {
      try {
        return await lane.run(() => runBuild(shape, key));
      } catch (error) {
        setBuildFailed(key, error);
        throw error;
      } finally {
        building.delete(key);
      }
    };

    const promise = runShared();

    building.set(key, promise);

    return promise;
  };

  const buildInBackground = async (shape: Readonly<TemplateShape>): Promise<void> => {
    try {
      await buildTemplate(shape);
    } catch {
      // setBuildFailed logged it
    }
  };

  return {
    find: (shape) => {
      const key = buildTemplateKey(deps.identity, shape);
      const record = readRecord(key);

      if (record.isOff) {
        return null;
      }

      const ready = findReady(key);

      if (ready !== null) {
        lastUsed.set(key, now());

        return ready;
      }

      // a shape booted once is not worth a template's RAM and disk
      record.misses += 1;

      if (record.misses >= MIN_MISSES && now() >= record.retryAt) {
        void buildInBackground(shape);
      }

      return null;
    },
    buildTemplate,
    reportFailure: (files, isTemplateFault) => {
      // Only the template's own fault counts, and only against the build that
      // failed: an imp's fault (a bad disk, an image that never pings) says
      // nothing of the template, and an evicted or rebuilt one is gone.
      if (!isTemplateFault || readMeta(files.key)?.buildId !== files.buildId) {
        return;
      }

      const record = readRecord(files.key);

      record.restoreFailures += 1;

      removeDir(files.key);

      if (record.restoreFailures >= MAX_RESTORE_FAILURES && !record.isOff) {
        record.isOff = true;

        deps.log(
          `impd: boot template ${files.key.slice(0, 12)} off until impd restarts: ${String(record.restoreFailures)} restores failed`,
        );
      }
    },
    reportRestored: (files) => {
      readRecord(files.key).restoreFailures = 0;
    },
    removeStale: () => {
      if (!existsSync(root)) {
        return [];
      }

      const live = new Set(building.keys());

      // a key names one host's identity and one shape (meta.json says which):
      // any other is stale, as is what a build cut short left
      const isCurrent = (name: string) => {
        const meta = readMeta(name);

        return meta !== null && buildTemplateKey(deps.identity, meta) === name;
      };

      const stale = readdirSync(root).filter(
        (name) =>
          name !== PLACEHOLDER_NAME &&
          !live.has(name) &&
          (name.startsWith('.') || !isCurrent(name)),
      );

      for (const name of stale) {
        removeDir(name);
      }

      return stale.filter((name) => !name.startsWith('.'));
    },
    listDrivePaths: () =>
      listTemplateKeys().flatMap((key) => {
        const meta = readMeta(key);

        return meta === null ? [] : [meta.systemDrivePath];
      }),
    stop: async () => {
      await Promise.allSettled(building.values());
    },
  };
}
