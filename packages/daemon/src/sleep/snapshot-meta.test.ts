import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildImpPaths } from '../storage/data-layout';
import {
  buildSnapshotIdentity,
  findColdBootReason,
  readSnapshotMeta,
  writeSnapshotMeta,
} from './snapshot-meta';
import type { HostIdentity, VmIdentity } from './vm-identity';
import { findOutdatedParts } from './vm-identity';

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(`${tmpdir()}/imp-snapshot-meta-`);

  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildHost(dir: string): HostIdentity {
  const systemDrivePath = `${dir}/drive.squashfs`;

  writeFileSync(systemDrivePath, 'drive');

  return {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: 'kernel-sha',
    systemDrive: 'drive-sha',
    systemDrivePath,
  };
}

test('a snapshot loads on a host with the same firecracker and host kernel', () => {
  withTempDir((dir) => {
    const host = buildHost(dir);

    expect(findColdBootReason({ ...host, agentVersion: '0.1.0' }, host)).toBeNull();
  });
});

test('a changed guest kernel or drive does not keep a snapshot from loading', () => {
  withTempDir((dir) => {
    const host = buildHost(dir);
    const snapshot = { ...host, guestKernel: 'old-kernel', systemDrive: 'old-drive-sha' };

    expect(findColdBootReason(snapshot, host)).toBeNull();
  });
});

test('firecracker, the snapshot format and the host kernel force a cold boot', () => {
  withTempDir((dir) => {
    const host = buildHost(dir);

    const reasons = [
      { firecrackerVersion: 'v1.16.0' },
      { snapshotVersion: 'v11.0.0' },
      { hostKernel: '6.1.0' },
    ].map((change) => findColdBootReason({ ...host, ...change }, host));

    expect(reasons).toEqual([
      'firecrackerVersion changed (v1.16.0 → v1.17.0)',
      'snapshotVersion changed (v11.0.0 → v12.0.0)',
      'hostKernel changed (6.1.0 → 6.6.87)',
    ]);
  });
});

test('a snapshot whose drive is gone, or that names none, boots cold', () => {
  withTempDir((dir) => {
    const host = buildHost(dir);
    const gone = { ...host, systemDrive: 'abcdef0123456789', systemDrivePath: `${dir}/gone` };
    const { systemDrivePath: _, ...legacy } = host;

    expect(findColdBootReason(gone, host)).toBe('its agent drive abcdef012345 is gone');
    expect(findColdBootReason(legacy, host)).toBe('the snapshot is from an older impd');
  });
});

test('a VM without a recorded identity sleeps into a snapshot that boots cold', () => {
  withTempDir((dir) => {
    const host = buildHost(dir);
    const vm: VmIdentity = { ...host, agentVersion: '0.1.0', bootReason: 'wake failed' };

    expect(buildSnapshotIdentity(vm, host)).toEqual({ ...host, agentVersion: '0.1.0' });

    const unknown = buildSnapshotIdentity(null, host);

    expect(findColdBootReason(unknown, host)).toBe('the snapshot is from an older impd');
  });
});

test('an older or newer meta still reads, so the imp stays asleep', () => {
  withTempDir((dir) => {
    const paths = buildImpPaths(dir, 'imp1');

    mkdirSync(paths.snapshotDir, { recursive: true });
    writeFileSync(paths.vmstate, 'vmstate');
    writeFileSync(paths.memFile, 'mem');

    const older = {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.6.87',
      guestKernel: '1b2c3d',
      systemDrive: '4e5f6a',
      createdAt: 1,
      memoryMib: 512,
      ramMib: 60,
    };

    writeFileSync(paths.snapshotMeta, JSON.stringify(older));

    expect(readSnapshotMeta(paths)).toEqual(older);

    writeFileSync(paths.snapshotMeta, JSON.stringify({ ...older, futureField: true }));

    expect(readSnapshotMeta(paths)).toEqual(older);
  });
});

test('a planted symlink or FIFO as meta.json reads as no snapshot and is replaced on write', () => {
  withTempDir((dir) => {
    const paths = buildImpPaths(dir, 'imp1');
    const outside = `${dir}/outside`;

    const meta = {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.6.87',
      guestKernel: '1b2c3d',
      systemDrive: '4e5f6a',
      createdAt: 1,
      memoryMib: 512,
      ramMib: 60,
    };

    mkdirSync(paths.snapshotDir, { recursive: true });
    writeFileSync(paths.vmstate, 'vmstate');
    writeFileSync(paths.memFile, 'mem');
    writeFileSync(outside, JSON.stringify(meta));
    symlinkSync(outside, paths.snapshotMeta);

    expect(readSnapshotMeta(paths)).toBeNull();

    writeSnapshotMeta(paths, meta);

    expect(readFileSync(outside, 'utf8')).toBe(JSON.stringify(meta));
    expect(readSnapshotMeta(paths)).toEqual(meta);

    rmSync(paths.snapshotMeta);

    Bun.spawnSync(['mkfifo', paths.snapshotMeta]);

    expect(readSnapshotMeta(paths)).toBeNull();
  });
});

test('a VM is outdated in each part the host has a newer one of', () => {
  withTempDir((dir) => {
    const host = buildHost(dir);

    expect(findOutdatedParts(host, host)).toEqual([]);

    expect(
      findOutdatedParts(
        { firecrackerVersion: 'v1.16.0', guestKernel: 'old', systemDrive: 'old' },
        host,
      ),
    ).toEqual(['firecracker', 'kernel', 'agent']);
  });
});

test('a snapshot from another IPv6 prefix boots cold; one with none wakes and counts as outdated', () => {
  withTempDir((dir) => {
    const host = { ...buildHost(dir), ipv6Prefix: 'fd12:3456:789a::/64' };
    const moved = findColdBootReason({ ...host, ipv6Prefix: 'fd00:1::/64' }, host);
    const turnedOff = findColdBootReason(host, { ...host, ipv6Prefix: null });
    const none = findColdBootReason({ ...host, ipv6Prefix: null }, host);
    const older = findColdBootReason({ ...host, ipv6Prefix: undefined }, host);

    expect(moved).toBe('the IPv6 prefix changed (fd00:1::/64 → fd12:3456:789a::/64)');
    expect(turnedOff).toBe('the IPv6 prefix changed (fd12:3456:789a::/64 → off)');
    expect([none, older]).toEqual([null, null]);
    expect(findOutdatedParts({ ...host, ipv6Prefix: null }, host)).toEqual(['ipv6']);
    expect(findOutdatedParts({ ...host, ipv6Prefix: undefined }, host)).toEqual(['ipv6']);
    expect(findOutdatedParts(host, host)).toEqual([]);

    expect(findOutdatedParts({ ...host, ipv6Prefix: null }, { ...host, ipv6Prefix: null })).toEqual(
      [],
    );
  });
});
