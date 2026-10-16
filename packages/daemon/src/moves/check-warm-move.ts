import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { WarmHost, WarmMove } from '@impz/api';
import { ORPCError } from '@orpc/server';
import type { Config } from '../config';
import type { ImpRecord } from '../db/imps';
import { listNetworkMembers } from '../db/networks';
import type { ImpDatabase } from '../db/open-database';
import type { EgressService } from '../egress/egress-service';
import { deriveSlotAddress } from '../net/addressing';
import { readTapMac } from '../net/tap-devices';
import { findColdBootReason, readSnapshotMeta, writeSnapshotMeta } from '../sleep/snapshot-meta';
import type { SnapshotMeta } from '../sleep/snapshot-meta';
import { readVmIdentity, writeVmIdentity } from '../sleep/vm-identity';
import type { HostIdentity } from '../sleep/vm-identity';
import { buildSystemDrivePath } from '../storage/data-layout';
import type { StorageBackend } from '../storage/storage-backend';
import type { MoveHeader } from './move-header';
import { MoveRequestError } from './move-request-error';
import { isSameHash } from './move-tickets';
import type { ReceiptBody } from './move-tickets';
import { buildWarmMove, findWarmMismatches } from './warm-facts';

interface WarmSendDeps {
  readonly config: Pick<Config, 'subnet'>;
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'resolveImpPaths'>;
  readonly egress: Pick<EgressService, 'readPolicy' | 'readAnswers'>;
  readonly readWarmHost: () => WarmHost;
  readonly readTapMac?: (tap: string) => string | null;
}

// A sleeping imp moves warm only to a target that can load its memory;
// else the refusal names each fact that differs
export async function checkWarmMove(
  deps: WarmSendDeps,
  imp: ImpRecord,
  meta: SnapshotMeta,
  target: WarmHost | null,
): Promise<WarmMove> {
  const egress = await deps.egress.readPolicy(imp.name);

  const move = buildWarmMove(imp.slot, egress.mode, meta, deps.readWarmHost());

  const mismatches =
    target === null
      ? ['the target does not say what it can load']
      : findWarmMismatches(move, target);

  // The guest knows its gateway by this tap's MAC. A tap made before taps
  // took their slot's MAC has a random one, which no target tap has; with
  // no tap (a host restart removed it), the guest may still hold one
  const address = deriveSlotAddress(imp.slot, { subnet: deps.config.subnet, portBase: 0 });
  const tapMac = (deps.readTapMac ?? readTapMac)(address.tap);

  if (tapMac === null) {
    mismatches.push(`it has no tap ${address.tap} since a restart; wake it once first`);
  } else if (tapMac !== address.hostMac) {
    mismatches.push(`its tap ${address.tap} has a MAC from before slot MACs (${tapMac})`);
  }

  // the guest holds its peers' addresses, which are other imps' on the target
  const members = await listNetworkMembers(deps.db);

  const networks = members
    .filter((member) => member.impId === imp.id)
    .map((member) => member.network);

  if (networks.length > 0) {
    mismatches.push(`it is on private networks (${networks.join(', ')}); impz net leave first`);
  }

  if (mismatches.length > 0) {
    throw new ORPCError('PRECONDITION_FAILED', {
      message: `${imp.name} cannot move with its memory: ${mismatches.join('; ')}. impz move --stop moves it cold`,
    });
  }

  return move;
}

// a sleeping imp's snapshot record, which a warm send carries
export function requireSnapshotMeta(
  deps: Pick<WarmSendDeps, 'storage'>,
  imp: ImpRecord,
): SnapshotMeta {
  const meta = readSnapshotMeta(deps.storage.resolveImpPaths(imp.id));

  if (meta === null) {
    throw new Error(`${imp.name} has no memory snapshot to move`);
  }

  return meta;
}

// a warm send's memory snapshot, and whether the target needs its drive
export interface WarmParts {
  readonly meta: SnapshotMeta;
  readonly isDriveIncluded: boolean;
}

// a warm send's part of the header: what the target checks, the snapshot's
// record and vm.json, and a box imp's resolved addresses
export async function buildWarmHeader(
  deps: WarmSendDeps,
  imp: ImpRecord,
  warm: WarmParts,
): Promise<NonNullable<MoveHeader['warm']>> {
  const egress = await deps.egress.readPolicy(imp.name);

  return {
    move: buildWarmMove(imp.slot, egress.mode, warm.meta, deps.readWarmHost()),
    meta: warm.meta,
    vm: readVmIdentity(deps.storage.resolveImpPaths(imp.id)),
    isDriveIncluded: warm.isDriveIncluded,
    answers: EGRESS_MODE_TRAITS[egress.mode].hasAllowList ? deps.egress.readAnswers(imp.slot) : [],
  };
}

interface WarmReceiveDeps {
  readonly dataDir: string;
  readonly storage: Pick<StorageBackend, 'resolveImpPaths'>;
  readonly egress: Pick<EgressService, 'writeAnswers'>;
  readonly readIdentity: () => HostIdentity;
  readonly readWarmHost: () => WarmHost;
}

// the facts of a warm move this host does not match, as a refusal
export function requireWarmMove(deps: Pick<WarmReceiveDeps, 'readWarmHost'>, move: WarmMove): void {
  const mismatches = findWarmMismatches(move, deps.readWarmHost());

  if (mismatches.length > 0) {
    throw new MoveRequestError(409, `this host cannot load the memory: ${mismatches.join('; ')}`);
  }
}

// Firecracker reopens the drive by the path the snapshot names: only this
// host's own path for that sha256, whether the drive came along or not
export function requireOwnDrivePath(
  deps: Pick<WarmReceiveDeps, 'dataDir'>,
  warm: NonNullable<MoveHeader['warm']>,
): void {
  const path = buildSystemDrivePath(deps.dataDir, warm.meta.systemDrive);
  const named = [warm.meta.systemDrivePath, warm.vm?.systemDrivePath];

  if (named.some((given) => given !== undefined && given !== path)) {
    throw new MoveRequestError(400, `the snapshot's drive is not at ${path}`);
  }
}

type ReceivedFile = ReceiptBody['files'][number];

interface WarmFiles {
  readonly impId: string;
  readonly warm: NonNullable<MoveHeader['warm']>;

  // reads the stream's next file, which must be of this kind, into the path
  readonly readFile: (
    kind: 'system-drive' | 'vmstate' | 'mem',
    path: string,
  ) => Promise<{ sha256: string; bytes: number }>;

  // where the system drive lands before it goes under its own sha256
  readonly temp: string;
  readonly onFile: (file: ReceivedFile) => void;
}

// A warm move's files, after the disk: the system drive when this host
// lacks it, then vmstate and mem straight into the snapshot directory,
// which loads nothing without meta.json. meta.json goes last.
export async function writeWarmFiles(deps: WarmReceiveDeps, files: WarmFiles): Promise<void> {
  const warm = files.warm;
  const paths = deps.storage.resolveImpPaths(files.impId);

  if (warm.isDriveIncluded) {
    const got = await files.readFile('system-drive', files.temp);

    await writeSystemDrive(deps, files.temp, warm.meta);

    files.onFile({ kind: 'system-drive', sha256: got.sha256, bytes: got.bytes });
  }

  mkdirSync(paths.snapshotDir, { recursive: true });

  for (const kind of ['vmstate', 'mem'] as const) {
    const path = kind === 'vmstate' ? paths.vmstate : paths.memFile;

    const got = await files.readFile(kind, path);

    files.onFile({ kind, sha256: got.sha256, bytes: got.bytes });
  }

  if (warm.vm !== null) {
    writeVmIdentity(paths, warm.vm);
  }

  for (const answer of warm.answers) {
    await deps.egress.writeAnswers(warm.move.slot, answer.names, [answer]);
  }

  // the wake's own check, before the record that lets a wake load it
  const reason = findColdBootReason(warm.meta, deps.readIdentity());

  if (reason !== null) {
    throw new MoveRequestError(409, `the memory snapshot cannot load here: ${reason}`);
  }

  writeSnapshotMeta(paths, warm.meta);
}

// A drive lands under its own sha256, which other snapshots trust: what
// arrived must hash to the name the snapshot gives it
async function writeSystemDrive(
  deps: Pick<WarmReceiveDeps, 'dataDir'>,
  temp: string,
  meta: Readonly<SnapshotMeta>,
): Promise<void> {
  const path = buildSystemDrivePath(deps.dataDir, meta.systemDrive);

  const sha256 = await readFileSha256(temp);

  if (!isSameHash(sha256, meta.systemDrive)) {
    throw new MoveRequestError(400, 'the system drive does not match its sha256');
  }

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    renameSync(temp, path);
  }
}

async function readFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}
