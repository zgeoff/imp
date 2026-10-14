import { existsSync, rmSync } from 'node:fs';
import { toJson } from '@bufbuild/protobuf';
import type { JsonValue } from '@bufbuild/protobuf';
import * as z from 'zod';
import { ServicesListSchema, SessionInfoSchema } from '../agent-client/agent-protocol';
import type { ServicesList } from '../agent-client/agent-protocol';
import { decodeAgentMessage } from '../agent-client/decode-agent-message';
import { hasAgentNameForms } from '../agent-client/has-agent-name-forms';
import { writeFileDurably, writeRenamed } from '../process/write-file-durably';
import type { SeenSession } from '../sessions/session-cache';
import type { ImpPaths } from '../storage/data-layout';
import { readRegularFile } from '../vmm/vm-files';
import { findCpuChange } from './cpu-identity';
import type { HostIdentity, VmIdentity } from './vm-identity';

// What a memory snapshot is tied to: the identity of the VM that wrote it, since the snapshot
// holds the guest kernel and the page cache of the system drive it reopens by path
// (docs/architecture/sleep-and-wake.md#4-gotchas, gotcha 6).
const SnapshotIdentitySchema = z.object({
  firecrackerVersion: z.string(),
  snapshotVersion: z.string(),
  hostKernel: z.string(),
  guestKernel: z.string(),
  systemDrive: z.string(),

  // left out by an older impd, whose snapshot then boots cold once, and for a
  // VM booted before impd kept its identity
  systemDrivePath: z.string().optional(),
  agentVersion: z.string().optional(),

  // the IPv6 /64 the guest's address is in; null for none
  ipv6Prefix: z.string().nullable().optional(),

  // the CPU the guest kernel picked its code paths on; left out by an older
  // impd, whose snapshot loads as before
  cpuModel: z.string().optional(),
  cpuFlags: z.string().optional(),
});

// Sessions and services keep the agent's JSON form, every field the agent
// sends included, as every impd writes them. A session whose names lack their
// agent's form fails the whole record, as a forged one.
const AGENT_RECORD_JSON = { useProtoFieldName: true, alwaysEmitImplicit: true } as const;

const SeenSessionJsonSchema = z.json().transform((json, ctx): SeenSession => {
  try {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new Error('a session is a JSON object');
    }

    const { observed_unix_ms: observed, ...rest } = json;
    const session = decodeAgentMessage(SessionInfoSchema, rest);

    if (!hasAgentNameForms(session)) {
      throw new Error('a session whose names lack their agent’s form');
    }

    return typeof observed === 'number' ? { ...session, observedUnixMs: observed } : session;
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: String(error) });

    return z.NEVER;
  }
});

const ServicesListJsonSchema = z.json().transform((json, ctx): ServicesList => {
  try {
    return decodeAgentMessage(ServicesListSchema, json);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: String(error) });

    return z.NEVER;
  }
});

export const SnapshotMetaSchema = SnapshotIdentitySchema.extend({
  createdAt: z.int(),
  memoryMib: z.int(),

  // the RAM the VM owned when it went to sleep: what a wake reserves
  ramMib: z.int().nonnegative(),

  // what an elastic guest held plugged past memoryMib, which the load
  // restores (docs/architecture/memory.md); left out when it held none
  pluggedMib: z.int().nonnegative().optional(),

  // the guest's sessions as it went to sleep, so listing them does not wake
  // it; left out by an older impd
  sessions: z.array(SeenSessionJsonSchema).readonly().optional(),

  // and its services, for services.list; left out when the agent did not
  // answer in time, or by an older impd
  services: ServicesListJsonSchema.optional(),
});

export type SnapshotIdentity = z.infer<typeof SnapshotIdentitySchema>;

export type SnapshotMeta = z.output<typeof SnapshotMetaSchema>;

// What a sleep records: the VM's identity. A VM booted before impd kept one
// gets the host's Firecracker and no drive, so it boots cold once.
export function buildSnapshotIdentity(
  vm: Readonly<VmIdentity> | null,
  host: Readonly<HostIdentity>,
): SnapshotIdentity {
  if (vm === null) {
    return {
      firecrackerVersion: host.firecrackerVersion,
      snapshotVersion: host.snapshotVersion,
      hostKernel: host.hostKernel,
      guestKernel: 'unknown',
      systemDrive: 'unknown',
    };
  }

  return {
    firecrackerVersion: vm.firecrackerVersion,
    snapshotVersion: vm.snapshotVersion,
    hostKernel: vm.hostKernel,
    guestKernel: vm.guestKernel,
    systemDrive: vm.systemDrive,
    systemDrivePath: vm.systemDrivePath,
    agentVersion: vm.agentVersion,
    ...(vm.ipv6Prefix !== undefined && { ipv6Prefix: vm.ipv6Prefix }),
    ...(vm.cpuModel !== undefined && { cpuModel: vm.cpuModel }),
    ...(vm.cpuFlags !== undefined && { cpuFlags: vm.cpuFlags }),
  };
}

// meta.json is the snapshot's commit record: written last, and durably, so
// the files it vouches for are complete
export function writeSnapshotMeta(
  paths: Pick<ImpPaths, 'snapshotMeta'>,
  meta: Readonly<SnapshotMeta>,
): void {
  const { sessions, services, ...identity } = meta;

  const json = {
    ...identity,
    ...(sessions !== undefined && {
      sessions: sessions.map((session) => encodeSeenSession(session)),
    }),
    ...(services !== undefined && {
      services: toJson(ServicesListSchema, services, AGENT_RECORD_JSON),
    }),
  };

  writeFileDurably(paths.snapshotMeta, `${JSON.stringify(json, null, 2)}\n`);
}

function encodeSeenSession(session: SeenSession): JsonValue {
  const json = toJson(SessionInfoSchema, session, AGENT_RECORD_JSON);

  if (
    session.observedUnixMs === undefined ||
    typeof json !== 'object' ||
    json === null ||
    Array.isArray(json)
  ) {
    return json;
  }

  return { ...json, observed_unix_ms: session.observedUnixMs };
}

// Without its record the snapshot does not load. A sleep drops it before it
// writes new files, so a crash mid-sleep cannot pair them with the old one; a
// wake drops it once the VM runs on its memory.
export function removeSnapshotMeta(paths: Readonly<ImpPaths>): void {
  rmSync(paths.snapshotMeta, { force: true });
  rmSync(buildLoadingPath(paths), { force: true });
}

// where the record waits while a wake loads it
function buildLoadingPath(paths: Pick<ImpPaths, 'snapshotMeta'>): string {
  return `${paths.snapshotMeta}.loading`;
}

// Before a load: from here the guest may run and write its disk, so after a
// crash the snapshot no longer loads. Reconcile reads the record here to adopt
// the VM the load left, or drops the snapshot when there is none.
export function setSnapshotLoading(paths: Readonly<ImpPaths>): void {
  writeRenamed(paths.snapshotMeta, buildLoadingPath(paths));
}

// the load never started the guest: its disk is as the snapshot left it
export function resetSnapshotLoading(paths: Readonly<ImpPaths>): void {
  writeRenamed(buildLoadingPath(paths), paths.snapshotMeta);
}

// the record of a load a crash cut short, or null
export function readLoadingMeta(paths: Readonly<ImpPaths>): SnapshotMeta | null {
  const path = buildLoadingPath(paths);

  try {
    return SnapshotMetaSchema.parse(JSON.parse(readRegularFile(path)));
  } catch {
    return null;
  }
}

// null when there is no complete snapshot to load
export function readSnapshotMeta(paths: Readonly<ImpPaths>): SnapshotMeta | null {
  if (!existsSync(paths.vmstate) || !existsSync(paths.memFile)) {
    return null;
  }

  try {
    return SnapshotMetaSchema.parse(JSON.parse(readRegularFile(paths.snapshotMeta)));
  } catch {
    return null;
  }
}

export function hasSnapshot(paths: Readonly<ImpPaths>): boolean {
  return readSnapshotMeta(paths) !== null;
}

// Why the snapshot cannot be loaded on this host, or null when it can. The
// guest kernel does not count: the VM holds it in memory. The drive counts
// only as the file the snapshot reopens, which stays while a snapshot names it.
export function findColdBootReason(
  meta: Readonly<SnapshotIdentity>,
  host: Readonly<HostIdentity>,
): string | null {
  const keys = ['firecrackerVersion', 'snapshotVersion', 'hostKernel'] as const;

  for (const key of keys) {
    if (meta[key] !== host[key]) {
      return `${key} changed (${meta[key]} → ${host[key]})`;
    }
  }

  if (meta.systemDrivePath === undefined) {
    return 'the snapshot is from an older impd';
  }

  const cpuChange = findCpuChange(meta, host);

  if (cpuChange !== null) {
    return cpuChange;
  }

  // a guest with an address in another prefix would send from it; one with
  // none wakes, and has no IPv6 until its next cold boot
  const hostPrefix = host.ipv6Prefix ?? null;

  if (typeof meta.ipv6Prefix === 'string' && meta.ipv6Prefix !== hostPrefix) {
    return `the IPv6 prefix changed (${meta.ipv6Prefix} → ${hostPrefix ?? 'off'})`;
  }

  if (!existsSync(meta.systemDrivePath)) {
    return `its agent drive ${meta.systemDrive.slice(0, 12)} is gone`;
  }

  return null;
}

// A stopped imp boots cold, and a restored disk invalidates the memory.
export function removeSnapshot(paths: Readonly<ImpPaths>): void {
  rmSync(paths.snapshotDir, { recursive: true, force: true });
}
