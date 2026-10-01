import { join } from 'node:path';
import * as z from 'zod';
import { countSlots, parseSubnet } from './net/addressing';
import type { Subnet } from './net/addressing';

const PortSchema = z.coerce.number().pipe(z.int().min(1).max(65_535));
const CountSchema = z.coerce.number().pipe(z.int().positive());
const DnsServersSchema = z.array(z.ipv4()).min(1);

const EnvSchema = z.object({
  IMP_DATA_DIR: z.string().default('/var/lib/imp'),
  IMP_API_PORT: PortSchema.default(7070),
  IMP_PROXY_PORT: PortSchema.default(7080),
  IMP_PORT_BASE: PortSchema.default(20_000),
  IMP_RAM_BUDGET_MIB: CountSchema.default(16_384),
  IMP_IDLE_TIMEOUT_S: CountSchema.default(60),
  IMP_DEFAULT_VCPUS: CountSchema.default(2),
  IMP_DEFAULT_MEMORY_MIB: CountSchema.default(2048),
  IMP_DNS: z.string().default('1.1.1.1,8.8.8.8').transform(splitList).pipe(DnsServersSchema),
  IMP_SUBNET: z.cidrv4().default('10.66.0.0/16'),
  IMP_FIRECRACKER_BIN: z.string().default('firecracker'),
  IMP_KERNEL: z.string().optional(),
  IMP_SYSTEM_DRIVE: z.string().optional(),
  IMP_DEFAULT_IMAGE: z.string().default('base'),
  TAILSCALE_AUTHKEY: z.string().optional(),
});

export interface Config {
  readonly dataDir: string;
  readonly apiPort: number;
  readonly proxyPort: number;
  readonly portBase: number;
  readonly ramBudgetMib: number;
  readonly idleTimeoutS: number;
  readonly defaultVcpus: number;
  readonly defaultMemoryMib: number;
  readonly dns: readonly string[];
  readonly subnet: Subnet;
  readonly firecrackerBin: string;
  readonly kernelPath: string;
  readonly systemDrivePath: string;

  // where impd copies the kernel and the system drive from on start, so a
  // rebuild never changes a file a running VM has open
  readonly kernelSource: string | null;
  readonly systemDriveSource: string | null;

  // the image `imps.create` uses when none is named; `ubuntu` stands in until
  // one by this name exists
  readonly defaultImage: string;
  readonly tailscaleAuthKey: string | null;
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

  return {
    dataDir: parsed.IMP_DATA_DIR,
    apiPort: parsed.IMP_API_PORT,
    proxyPort: parsed.IMP_PROXY_PORT,
    portBase: parsed.IMP_PORT_BASE,
    ramBudgetMib: parsed.IMP_RAM_BUDGET_MIB,
    idleTimeoutS: parsed.IMP_IDLE_TIMEOUT_S,
    defaultVcpus: parsed.IMP_DEFAULT_VCPUS,
    defaultMemoryMib: parsed.IMP_DEFAULT_MEMORY_MIB,
    dns: parsed.IMP_DNS,
    subnet,
    firecrackerBin: parsed.IMP_FIRECRACKER_BIN,
    kernelPath: join(parsed.IMP_DATA_DIR, 'system', 'vmlinux'),
    systemDrivePath: join(parsed.IMP_DATA_DIR, 'system', 'imp-system.squashfs'),
    kernelSource: parsed.IMP_KERNEL ?? null,
    systemDriveSource: parsed.IMP_SYSTEM_DRIVE ?? null,
    defaultImage: parsed.IMP_DEFAULT_IMAGE,
    tailscaleAuthKey: parsed.TAILSCALE_AUTHKEY ?? null,
  };
}
