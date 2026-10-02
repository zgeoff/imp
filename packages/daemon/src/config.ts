import { join } from 'node:path';
import * as z from 'zod';
import { TailnetRulesSchema } from './auth/tailnet-identity';
import type { TailnetRule } from './auth/tailnet-identity';
import { loadBackupConfig } from './backup/backup-config';
import type { BackupConfig } from './backup/backup-config';
import { HttpsEnvSchema, parseHttpsConfig } from './https/https-config';
import type { HttpsConfig } from './https/https-config';
import { countSlots, isTailnetOverlap, parseSubnet } from './net/addressing';
import type { Subnet } from './net/addressing';
import type { StorageBackendKind } from './storage/storage-backend';
import {
  TailnetNamesEnvSchema,
  parseTailnetNamesConfig,
} from './tailnet-names/tailnet-names-config';
import type { TailnetNamesConfig } from './tailnet-names/tailnet-names-config';
import type { WatchdogAction } from './watchdog/agent-watchdog';

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

  // false: <data>/ssh/authorized_keys logs nobody in; only keys bound to
  // tokens do
  IMP_SSH_AUTHORIZED_KEYS: z.enum(['true', 'false']).default('true'),
  IMP_BROKER_PORT: PortSchema.default(7081),
  IMP_BROKER_TEST_UPSTREAMS: z.string().optional(),
  IMP_EGRESS_DNS_PORT: PortSchema.default(7053),
  IMP_RAM_BUDGET_MIB: CountSchema.default(16_384),
  IMP_IDLE_TIMEOUT_S: CountSchema.default(60),
  IMP_IDLE_CPU_PERCENT: z.coerce.number().nonnegative().default(10),
  IMP_BOOT_RESERVE_PERCENT: CountSchema.pipe(z.int().max(100)).default(50),
  IMP_WAKE_RESERVE_MIB: CountSchema.default(256),
  IMP_SLEEP_MIN_GUEST_UPTIME_MS: z.coerce.number().pipe(z.int().nonnegative()).default(1500),
  IMP_WATCHDOG_TIMEOUT_S: CountSchema.default(60),
  IMP_WATCHDOG_ACTION: z.enum(['report', 'restart', 'snapshot']).default('report'),
  IMP_DEFAULT_VCPUS: CountSchema.default(2),
  IMP_DEFAULT_MEMORY_MIB: CountSchema.default(2048),
  IMP_DEFAULT_DISK_GIB: CountSchema.default(32),
  IMP_DISK_RESERVE_GIB: CountSchema.optional(),
  IMP_BUILD_CONTEXT_MAX_MIB: CountSchema.default(1024),
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
  IMP_TAILNET_IDENTITIES: z.string().optional(),
  ...HttpsEnvSchema.shape,
  ...TailnetNamesEnvSchema.shape,
});

export interface Config {
  readonly dataDir: string;
  readonly apiPort: number;
  readonly proxyPort: number;
  readonly portBase: number;

  // the SSH gateway's port, or null when it is off
  readonly sshPort: number | null;

  // whether a key in <data>/ssh/authorized_keys logs in
  readonly sshAuthorizedKeys: boolean;

  // the credential broker's port on every guest's gateway address
  readonly brokerPort: number;

  // the egress resolver's port on every guest's gateway address; box and
  // none imps reach it through a redirect of port 53
  readonly egressDnsPort: number;

  // tests only: a file of fake upstreams for granted hosts
  // (broker/test-upstreams.ts)
  readonly brokerTestUpstreams: string | null;
  readonly ramBudgetMib: number;
  readonly idleTimeoutS: number;

  // Firecracker CPU (percent of one core) above which an imp counts as busy
  readonly idleCpuPercent: number;

  // the RAM the governor reserves before a cold boot, as a percentage of the
  // imp's memory, and the least it reserves before a wake
  // (docs/architecture/sleep-and-wake.md#the-ram-governor)
  readonly bootReservePercent: number;
  readonly wakeReserveMib: number;

  // a sleep waits until the guest has been up this long, so the next wake
  // gets its clock back (docs/architecture/sleep-and-wake.md#young-guests);
  // 0 turns the wait off
  readonly sleepMinGuestUptimeMs: number;

  // how long an agent may stay silent before the watchdog acts, and what it
  // does then (docs/architecture/sleep-and-wake.md#the-watchdog)
  readonly watchdogTimeoutS: number;
  readonly watchdogAction: WatchdogAction;
  readonly defaultVcpus: number;
  readonly defaultMemoryMib: number;

  // the disk an imp gets when `imps.create` names no size
  readonly defaultDiskBytes: number;

  // free space no write may take; null is max(5 GiB, 5 % of the filesystem)
  readonly diskReserveBytes: number | null;

  // the largest build context a client may upload to IMAGE_BUILD_PATH
  readonly buildContextMaxBytes: number;
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

  // rules that give tailnet peers a scope (docs/guides/tokens.md); null
  // when IMP_TAILNET_IDENTITIES is unset, and a peer then needs a token
  readonly tailnetRules: readonly TailnetRule[] | null;

  // the web dashboard's built files (packages/dashboard/dist), served at /;
  // null serves a note that this impd has none
  readonly dashboardDir: string | null;

  // off-host backups with restic; null when IMP_BACKUP_REPOSITORY is unset
  readonly backup: BackupConfig | null;

  // imps at https://<name>.<domain> (docs/guides/https.md); null without
  // IMP_DOMAIN
  readonly https: HttpsConfig | null;

  // each imp's own name on the tailnet, as a Tailscale Service
  // (docs/guides/tailscale.md#per-imp-names); null unless IMP_TAILNET_NAMES=1
  readonly tailnetNames: TailnetNamesConfig | null;
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

  if (isTailnetOverlap(subnet)) {
    throw new Error(`IMP_SUBNET ${parsed.IMP_SUBNET} overlaps Tailscale's 100.64.0.0/10`);
  }

  for (const [name, port] of [
    ['IMP_API_PORT', parsed.IMP_API_PORT],
    ['IMP_PROXY_PORT', parsed.IMP_PROXY_PORT],
  ] as const) {
    if (port >= parsed.IMP_PORT_BASE && port <= lastPort) {
      throw new Error(
        `${name} ${String(port)} falls in the imp ports ${String(parsed.IMP_PORT_BASE)}-${String(lastPort)}`,
      );
    }
  }

  if (parsed.IMP_STORAGE_BACKEND === 'zfs' && parsed.IMP_ZFS_ROOT === undefined) {
    throw new Error(
      'IMP_STORAGE_BACKEND=zfs needs IMP_ZFS_ROOT, the dataset mounted on IMP_DATA_DIR',
    );
  }

  const isTailnetNode = parsed.TAILSCALE_AUTHKEY !== undefined || parsed.IMP_TAILSCALE_NODE === '1';
  const https = parseHttpsConfig(parsed);

  if (https !== null && https.public !== null) {
    checkPublicPorts(
      https.public,
      [
        ['IMP_API_PORT', parsed.IMP_API_PORT],
        ['IMP_PROXY_PORT', parsed.IMP_PROXY_PORT],
        ['IMP_BROKER_PORT', parsed.IMP_BROKER_PORT],
        ['IMP_EGRESS_DNS_PORT', parsed.IMP_EGRESS_DNS_PORT],
        ['IMP_SSH_PORT', parsed.IMP_SSH_PORT],
        ['IMP_HTTPS_PORT', https.httpsPort],
        ['IMP_HTTP_PORT', https.httpPort],
      ],
      [parsed.IMP_PORT_BASE, lastPort],
    );
  }

  return {
    dataDir: parsed.IMP_DATA_DIR,
    apiPort: parsed.IMP_API_PORT,
    proxyPort: parsed.IMP_PROXY_PORT,
    portBase: parsed.IMP_PORT_BASE,
    sshPort: parsed.IMP_SSH_PORT === 0 ? null : parsed.IMP_SSH_PORT,
    sshAuthorizedKeys: parsed.IMP_SSH_AUTHORIZED_KEYS === 'true',
    brokerPort: parsed.IMP_BROKER_PORT,
    egressDnsPort: parsed.IMP_EGRESS_DNS_PORT,
    brokerTestUpstreams: parsed.IMP_BROKER_TEST_UPSTREAMS ?? null,
    ramBudgetMib: parsed.IMP_RAM_BUDGET_MIB,
    idleTimeoutS: parsed.IMP_IDLE_TIMEOUT_S,
    idleCpuPercent: parsed.IMP_IDLE_CPU_PERCENT,
    bootReservePercent: parsed.IMP_BOOT_RESERVE_PERCENT,
    wakeReserveMib: parsed.IMP_WAKE_RESERVE_MIB,
    sleepMinGuestUptimeMs: parsed.IMP_SLEEP_MIN_GUEST_UPTIME_MS,
    watchdogTimeoutS: parsed.IMP_WATCHDOG_TIMEOUT_S,
    watchdogAction: parsed.IMP_WATCHDOG_ACTION,
    defaultVcpus: parsed.IMP_DEFAULT_VCPUS,
    defaultMemoryMib: parsed.IMP_DEFAULT_MEMORY_MIB,
    defaultDiskBytes: parsed.IMP_DEFAULT_DISK_GIB * 1024 ** 3,
    diskReserveBytes:
      parsed.IMP_DISK_RESERVE_GIB === undefined ? null : parsed.IMP_DISK_RESERVE_GIB * 1024 ** 3,
    buildContextMaxBytes: parsed.IMP_BUILD_CONTEXT_MAX_MIB * 1024 ** 2,
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
    tailscaleEnabled: isTailnetNode,
    tailscaleHostname: parsed.IMP_TAILSCALE_HOSTNAME,
    tailnetRules: parseTailnetRules(parsed.IMP_TAILNET_IDENTITIES),
    dashboardDir: parsed.IMP_DASHBOARD_DIR ?? null,
    backup: loadBackupConfig(present),
    https,
    tailnetNames: parseTailnetNamesConfig(parsed, parsed.IMP_DATA_DIR, isTailnetNode),
  };
}

// The public listeners bind every address in the host container, so a port
// any other listener holds would make one of them fail at start.
function checkPublicPorts(
  ports: Readonly<{ httpsPort: number; httpPort: number }>,
  others: readonly (readonly [string, number])[],
  slotPorts: readonly [number, number],
): void {
  const [first, last] = slotPorts;

  const publics = [
    ['IMP_PUBLIC_HTTPS_PORT', ports.httpsPort],
    ['IMP_PUBLIC_HTTP_PORT', ports.httpPort],
  ] as const;

  if (ports.httpsPort === ports.httpPort) {
    throw new Error('IMP_PUBLIC_HTTPS_PORT and IMP_PUBLIC_HTTP_PORT must differ');
  }

  for (const [name, port] of publics) {
    const clash = others.find(([, other]) => other === port);

    if (clash !== undefined) {
      throw new Error(`${name} ${String(port)} is also ${clash[0]}; give it a port of its own`);
    }

    if (port >= first && port <= last) {
      throw new Error(
        `${name} ${String(port)} is one of the imps' ports, ${String(first)} to ${String(last)}`,
      );
    }
  }
}

// IMP_TAILNET_IDENTITIES is a JSON array of rules, such as
// [{"match":"user:me@example.com","scope":"manage"}]
function parseTailnetRules(text: string | undefined): readonly TailnetRule[] | null {
  if (text === undefined) {
    return null;
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('IMP_TAILNET_IDENTITIES is not JSON');
  }

  const rules = TailnetRulesSchema.safeParse(json);

  if (!rules.success) {
    throw new Error(`IMP_TAILNET_IDENTITIES: ${z.prettifyError(rules.error)}`);
  }

  return rules.data;
}
