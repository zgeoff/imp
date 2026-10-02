import { join } from 'node:path';
import * as z from 'zod';
import { loadBackupConfig } from './backup/backup-config';
import type { BackupConfig } from './backup/backup-config';
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

  // 0 turns the SSH gateway off
  IMP_SSH_PORT: z.coerce.number().pipe(z.int().min(0).max(65_535)).default(22),
  IMP_BROKER_PORT: PortSchema.default(7081),
  IMP_BROKER_TEST_UPSTREAMS: z.string().optional(),
  IMP_RAM_BUDGET_MIB: CountSchema.default(16_384),
  IMP_IDLE_TIMEOUT_S: CountSchema.default(60),
  IMP_IDLE_CPU_PERCENT: z.coerce.number().nonnegative().default(10),
  IMP_BOOT_RESERVE_PERCENT: CountSchema.pipe(z.int().max(100)).default(50),
  IMP_WAKE_RESERVE_MIB: CountSchema.default(256),
  IMP_SLEEP_MIN_GUEST_UPTIME_MS: z.coerce.number().pipe(z.int().nonnegative()).default(1500),
  IMP_DEFAULT_VCPUS: CountSchema.default(2),
  IMP_DEFAULT_MEMORY_MIB: CountSchema.default(2048),
  IMP_DEFAULT_DISK_GIB: CountSchema.default(32),
  IMP_DISK_RESERVE_GIB: CountSchema.optional(),
  IMP_DNS: z.string().default('1.1.1.1,8.8.8.8').transform(splitList).pipe(DnsServersSchema),
  IMP_SUBNET: z.cidrv4().default('10.66.0.0/16'),
  IMP_FIRECRACKER_BIN: z.string().default('firecracker'),
  IMP_KERNEL: z.string().optional(),
  IMP_SYSTEM_DRIVE: z.string().optional(),
  IMP_DEFAULT_IMAGE: z.string().default('base'),
  IMP_STORAGE_BACKEND: z.enum(['xfs', 'zfs']).default('xfs'),
  IMP_ZFS_ROOT: z.string().optional(),
  TAILSCALE_AUTHKEY: z.string().optional(),
  IMP_TAILSCALE_HOSTNAME: z.string().default('imp'),
  IMP_DASHBOARD_DIR: z.string().optional(),
  ...HttpsEnvSchema.shape,
});

export interface Config {
  readonly dataDir: string;
  readonly apiPort: number;
  readonly proxyPort: number;
  readonly portBase: number;

  // the SSH gateway's port, or null when it is off
  readonly sshPort: number | null;

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

  // a sleep waits until the guest has been up this long, so the next wake
  // gets its clock back (docs/architecture/sleep-and-wake.md#young-guests);
  // 0 turns the wait off
  readonly sleepMinGuestUptimeMs: number;
  readonly defaultVcpus: number;
  readonly defaultMemoryMib: number;

  // the disk an imp gets when `imps.create` names no size
  readonly defaultDiskBytes: number;

  // free space no write may take; null is max(5 GiB, 5 % of the filesystem)
  readonly diskReserveBytes: number | null;
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
  readonly tailscaleAuthKey: string | null;

  // the tailnet hostname impd asks for; per-imp URLs use the name the node
  // got (http://<name>:<tailnetPort>), which differs while an older node holds it
  readonly tailscaleHostname: string;

  // the web dashboard's built files (packages/dashboard/dist), served at /;
  // null serves a note that this impd has none
  readonly dashboardDir: string | null;

  // off-host backups with restic; null when IMP_BACKUP_REPOSITORY is unset
  readonly backup: BackupConfig | null;

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
    sshPort: parsed.IMP_SSH_PORT === 0 ? null : parsed.IMP_SSH_PORT,
    brokerPort: parsed.IMP_BROKER_PORT,
    brokerTestUpstreams: parsed.IMP_BROKER_TEST_UPSTREAMS ?? null,
    ramBudgetMib: parsed.IMP_RAM_BUDGET_MIB,
    idleTimeoutS: parsed.IMP_IDLE_TIMEOUT_S,
    idleCpuPercent: parsed.IMP_IDLE_CPU_PERCENT,
    bootReservePercent: parsed.IMP_BOOT_RESERVE_PERCENT,
    wakeReserveMib: parsed.IMP_WAKE_RESERVE_MIB,
    sleepMinGuestUptimeMs: parsed.IMP_SLEEP_MIN_GUEST_UPTIME_MS,
    defaultVcpus: parsed.IMP_DEFAULT_VCPUS,
    defaultMemoryMib: parsed.IMP_DEFAULT_MEMORY_MIB,
    defaultDiskBytes: parsed.IMP_DEFAULT_DISK_GIB * 1024 ** 3,
    diskReserveBytes:
      parsed.IMP_DISK_RESERVE_GIB === undefined ? null : parsed.IMP_DISK_RESERVE_GIB * 1024 ** 3,
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
    tailscaleAuthKey: parsed.TAILSCALE_AUTHKEY ?? null,
    tailscaleHostname: parsed.IMP_TAILSCALE_HOSTNAME,
    dashboardDir: parsed.IMP_DASHBOARD_DIR ?? null,
    backup: loadBackupConfig(present),
    https: parseHttpsConfig(parsed),
  };
}
