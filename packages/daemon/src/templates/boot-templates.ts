import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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
import { BALLOON } from '../vmm/configure-vm';
import type { TemplateBuildPlan } from '../vmm/template-vm';

// The cmdline of every template: stage 1 parks for a claim, and nothing in
// it names an imp (docs/architecture/boot-templates.md#make)
export const TEMPLATE_BOOT_ARGS = [
  'console=ttyS0 reboot=k panic=1 pci=off',
  'i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd',
  'root=/dev/vdb rootfstype=squashfs ro init=/imp-agent',
  'imp.template=1',
].join(' ');

// the devices every VM gets, as setupVm sets them
const DEVICES = {
  drives: ['rootfs', 'system'],
  vsockCid: 3,
  network: ['eth0'],
  balloon: BALLOON,
};

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
  tailnetPort: 0,
};

const PLACEHOLDER_BYTES = 1024 * 1024;
const PLACEHOLDER_NAME = 'placeholder.ext4';

const TemplateMetaSchema = z.object({
  vcpus: z.int().positive(),
  memoryMib: z.int().positive(),
  systemDrivePath: z.string(),
});

type TemplateMeta = z.infer<typeof TemplateMetaSchema>;

export interface TemplateShape {
  readonly vcpus: number;
  readonly memoryMib: number;
}

export interface TemplateFiles {
  readonly key: string;
  readonly vmstate: string;
  readonly memFile: string;
}

export interface BootTemplates {
  // the ready template for the shape, or null; a miss starts its build in
  // the background, which later creates find
  readonly find: (shape: Readonly<TemplateShape>) => TemplateFiles | null;

  // the build itself, shared by every miss of one key while it runs
  readonly buildTemplate: (shape: Readonly<TemplateShape>) => Promise<TemplateFiles>;

  // a template whose restore failed: the next miss builds it again
  readonly discard: (key: string) => void;

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
  readonly admission?: RamAdmission | undefined;
  readonly log: (message: string) => void;
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
    bootArgs: TEMPLATE_BOOT_ARGS,
    devices: DEVICES,
    memoryMib: shape.memoryMib,
    vcpus: shape.vcpus,
  };

  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function isReady(files: Readonly<TemplateFiles>): boolean {
  return existsSync(files.vmstate) && existsSync(files.memFile);
}

export function createBootTemplates(deps: BootTemplateDeps): BootTemplates {
  const root = join(deps.dataDir, 'templates');

  // the snapshot names this path, so it is the same for every template
  const placeholder = join(root, PLACEHOLDER_NAME);

  const building = new Map<string, Promise<TemplateFiles>>();

  // one build at a time: they share the template tap
  const lane = createSemaphore(1);

  const findFiles = (key: string): TemplateFiles => {
    const dir = join(root, key);

    return { key, vmstate: join(dir, 'vmstate'), memFile: join(dir, 'mem') };
  };

  const readMeta = (key: string): TemplateMeta | null => {
    try {
      const text = readFileSync(join(root, key, 'meta.json'), 'utf8');

      return TemplateMetaSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
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
  };

  const runBuild = async (shape: Readonly<TemplateShape>, key: string): Promise<TemplateFiles> => {
    const files = findFiles(key);
    const work = join(root, `.build-${Bun.randomUUIDv7()}`);
    const runDir = join(work, 'run');
    const id = `template-${key.slice(0, 12)}`;

    mkdirSync(runDir, { recursive: true });

    if (!existsSync(placeholder)) {
      writeFileSync(placeholder, '');
      truncateSync(placeholder, PLACEHOLDER_BYTES);
    }

    await deps.admission?.admit({
      id,
      name: 'boot template',
      reserveMib: Math.ceil((shape.memoryMib * deps.bootReservePercent) / 100),
      memoryMib: shape.memoryMib,
    });

    const started = performance.now();

    try {
      await deps.taps.setupTap(TEMPLATE_ADDRESS);

      const snapshotDir = join(work, 'snapshot');

      await deps.buildVm({
        firecrackerBin: deps.firecrackerBin,
        kernelPath: deps.kernelPath,
        systemDrivePath: deps.identity.systemDrivePath,
        bootArgs: TEMPLATE_BOOT_ARGS,
        vcpus: shape.vcpus,
        memoryMib: shape.memoryMib,
        paths: {
          apiSocket: join(runDir, 'api.sock'),
          vsockSocket: join(runDir, 'vsock.sock'),
          logFile: join(runDir, 'firecracker.log'),
          pidFile: join(runDir, 'pid'),
        },
        placeholderPath: placeholder,
        tap: TEMPLATE_ADDRESS.tap,
        guestMac: TEMPLATE_ADDRESS.guestMac,
        minGuestUptimeMs: deps.minGuestUptimeMs,
        snapshotDir,
        vmstate: join(snapshotDir, 'vmstate'),
        memFile: join(snapshotDir, 'mem'),
      });

      // zero pages become holes, before any VM maps the file; never after
      await runCommand(['fallocate', '--dig-holes', join(snapshotDir, 'mem')]);

      writeFileSync(
        join(snapshotDir, 'meta.json'),
        `${JSON.stringify({ ...shape, systemDrivePath: deps.identity.systemDrivePath }, null, 2)}\n`,
      );

      renameSync(snapshotDir, join(root, key));

      const ms = Math.round(performance.now() - started);

      deps.log(`impd: boot template ${key.slice(0, 12)} built in ${String(ms)}ms`);

      return files;
    } finally {
      deps.admission?.release(id);
      rmSync(work, { recursive: true, force: true });
    }
  };

  const buildTemplate = (shape: Readonly<TemplateShape>): Promise<TemplateFiles> => {
    const key = buildTemplateKey(deps.identity, shape);
    const files = findFiles(key);

    if (isReady(files)) {
      return Promise.resolve(files);
    }

    const inFlight = building.get(key);

    if (inFlight !== undefined) {
      return inFlight;
    }

    const runShared = async (): Promise<TemplateFiles> => {
      try {
        return await lane.run(() => runBuild(shape, key));
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
    } catch (error) {
      deps.log(`impd: boot template build failed: ${readErrorMessage(error)}`);
    }
  };

  return {
    find: (shape) => {
      const files = findFiles(buildTemplateKey(deps.identity, shape));

      if (isReady(files)) {
        return files;
      }

      void buildInBackground(shape);

      return null;
    },
    buildTemplate,
    discard: (key) => {
      removeDir(key);
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
