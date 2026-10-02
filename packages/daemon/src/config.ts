import { join } from 'node:path';
import * as z from 'zod';
import { HttpsEnvSchema, parseHttpsConfig } from './https/https-config';
import type { HttpsConfig } from './https/https-config';
import { countSlots, parseSubnet } from './net/addressing';
import type { Subnet } from './net/addressing';
import type { StorageBackendKind } from './storage/storage-backend';

const PortSchema = z.coerce.number().pipe(z.int().min(1).max(65_535));
const CountSchema = z.coerce.number().pipe(z.int().positive());
const DnsServersSchema = z.array(z.ipv4()).min(1);

const EnvSchema = z.object({
  IMP_DATA_DIR: z.string().default('/var/lib/imp'),
  IMP_API_PORT: PortSchema.default(7070),
  IMP_PROXY_PORT: PortSchema.default(7080),
  IMP_PORT_BASE: PortSchema.default(20_000),
  IMP_BROKER_PORT: PortSchema.default(7081),
  IMP_BROKER_TEST_UPSTREAMS: z.string().optional(),
  IMP_RAM_BUDGET_MIB: CountSchema.default(16_384),
  IMP_IDLE_TIMEOUT_S: CountSchema.default(60),
  IMP_IDLE_CPU_PERCENT: z.coerce.number().nonnegative().default(10),
  IMP_BOOT_RESERVE_PERCENT: CountSchema.pipe(z.int().max(100)).default(50),
  IMP_WAKE_RESERVE_MIB: CountSchema.default(256),
  IMP_DEFAULT_VCPUS: CountSchema.default(2),
  IMP_DEFAULT_MEMORY_MIB: CountSchema.default(2048),
  IMP_DNS: z.string().default('1.1.1.1,8.8.8.8').transform(splitList).pipe(DnsServersSchema),
  IMP_SUBNET: z.cidrv4().default('10.66.0.0/16'),
  IMP_FIRECRACKER_BIN: z.string().default('firecracker'),
  IMP_KERNEL: z.string().optional(),
  IMP_SYSTEM_DRIVE: z.string().optional(),
  IMP_DEFAULT_IMAGE: z.string().default('base'),
  IMP_STORAGE_BACKEND: z.enum(['xfs', 'zfs']).default('xfs'),
  IMP_ZFS_ROOT: z.string().optional(),
  TAILSCALE_AUTHKEY: z.string().optional(),
  IMP_TAILSCALE_NODE: z.literal('1').optional(),
  IMP_TAILSCALE_HOSTNAME: z.string().default('imp'),
  IMP_DASHBOARD_DIR: z.string().optional(),
  ...HttpsEnvSchema.shape,
});

export interface Config {
  readonly dataDir: string;
  readonly apiPort: number;
  readonly proxyPort: number;
  readonly portBase: number;

  // the credential broker's port on every guest's gateway address
  readonly brokerPort: number;

  // tests only: a file of fake upstreams for granted hosts
  // (broker/test-upstreams.ts)
  readonly brokerTestUpstreams: string | null;
  readonly ramBudgetMib: number;
  readonly idleTimeoutS: number;

  // Firecracker CPU (percent of one core) above which an imp counts as busy
  readonly idleCpuPercent: number;

  // the RAM the governor reserves before a cold boot, as a percentage of the
  // imp's memory, and the least it reserves before a wake (DESIGN 2.9)
  readonly bootReservePercent: number;
  readonly wakeReserveMib: number;
  readonly defaultVcpus: number;
  readonly defaultMemoryMib: number;
  readonly dns: readonly string[];
  readonly subnet: Subnet;
  readonly firecrackerBin: string;
  readonly kernelPath: string;

  // where impd copies the kernel and the system drive from on start, so a
  // rebuild never changes a file a running VM has open; without
  // IMP_SYSTEM_DRIVE, the drive is the one in <dataDir>/system
  readonly kernelSource: string | null;
  readonly systemDriveSource: string;

  // the image `imps.create` uses when none is named; `ubuntu` stands in until
  // one by this name exists
  readonly defaultImage: string;

  // where disks live (docs/architecture/storage.md); with zfs, zfsRoot is the
  // dataset mounted on dataDir, such as tank/imp
  readonly storageBackend: StorageBackendKind;
  readonly zfsRoot: string | null;

  // the host container is a tailnet node: it has a key, or the entrypoint
  // started tailscaled from saved node state (IMP_TAILSCALE_NODE=1) after
  // deploy/bootstrap.sh blanked the spent key
  readonly tailscaleEnabled: boolean;

  // the tailnet hostname impd asks for; per-imp URLs use the name the node
  // got (http://<name>:<tailnetPort>), which differs while an older node holds it
  readonly tailscaleHostname: string;

  // the web dashboard's built files (packages/dashboard/dist), served at /;
  // null serves a note that this impd has none
  readonly dashboardDir: string | null;

  // imps at https://<name>.<domain> (docs/guides/https.md); null without
  // IMP_DOMAIN
  readonly https: HttpsConfig | null;
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim());
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  // an empty variable (`TAILSCALE_AUTHKEY=` in an env file) means unset
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.parse(present);
  const subnet = parseSubnet(parsed.IMP_SUBNET);
  const lastPort = parsed.IMP_PORT_BASE + countSlots(subnet) - 1;

  if (lastPort > 65_535) {
    throw new Error(
      `IMP_PORT_BASE ${String(parsed.IMP_PORT_BASE)} leaves no port for every slot of ${parsed.IMP_SUBNET}`,
    );
  }

  if (parsed.IMP_STORAGE_BACKEND === 'zfs' && parsed.IMP_ZFS_ROOT === undefined) {
    throw new Error(
      'IMP_STORAGE_BACKEND=zfs needs IMP_ZFS_ROOT, the dataset mounted on IMP_DATA_DIR',
    );
  }

  return {
    dataDir: parsed.IMP_DATA_DIR,
    apiPort: parsed.IMP_API_PORT,
    proxyPort: parsed.IMP_PROXY_PORT,
    portBase: parsed.IMP_PORT_BASE,
    brokerPort: parsed.IMP_BROKER_PORT,
    brokerTestUpstreams: parsed.IMP_BROKER_TEST_UPSTREAMS ?? null,
    ramBudgetMib: parsed.IMP_RAM_BUDGET_MIB,
    idleTimeoutS: parsed.IMP_IDLE_TIMEOUT_S,
    idleCpuPercent: parsed.IMP_IDLE_CPU_PERCENT,
    bootReservePercent: parsed.IMP_BOOT_RESERVE_PERCENT,
    wakeReserveMib: parsed.IMP_WAKE_RESERVE_MIB,
    defaultVcpus: parsed.IMP_DEFAULT_VCPUS,
    defaultMemoryMib: parsed.IMP_DEFAULT_MEMORY_MIB,
    dns: parsed.IMP_DNS,
    subnet,
    firecrackerBin: parsed.IMP_FIRECRACKER_BIN,
    kernelPath: join(parsed.IMP_DATA_DIR, 'system', 'vmlinux'),
    kernelSource: parsed.IMP_KERNEL ?? null,
    systemDriveSource:
      parsed.IMP_SYSTEM_DRIVE ?? join(parsed.IMP_DATA_DIR, 'system', 'imp-system.squashfs'),
    defaultImage: parsed.IMP_DEFAULT_IMAGE,
    storageBackend: parsed.IMP_STORAGE_BACKEND,
    zfsRoot: parsed.IMP_ZFS_ROOT ?? null,
    tailscaleEnabled: parsed.TAILSCALE_AUTHKEY !== undefined || parsed.IMP_TAILSCALE_NODE === '1',
    tailscaleHostname: parsed.IMP_TAILSCALE_HOSTNAME,
    dashboardDir: parsed.IMP_DASHBOARD_DIR ?? null,
    https: parseHttpsConfig(parsed),
  };
}
