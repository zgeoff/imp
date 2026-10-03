import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOwnedReferences } from './owned-references';

const REFERENCE = 'docker.io/library/busybox:1.36';
const OWNED = { id: `sha256:${'a'.repeat(64)}`, taggedAt: '2026-10-04T00:00:01Z' };

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'imp-owned-references-'));

  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the record outlives a restart, in a file only the proxy reads, with no temp file left', () => {
  withDir((dir) => {
    const path = join(dir, 'owned-references.json');
    const owned = loadOwnedReferences(path, () => {});

    owned.write(REFERENCE, OWNED);

    expect(loadOwnedReferences(path, () => {}).read(REFERENCE)).toEqual(OWNED);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    owned.remove(REFERENCE);

    expect(loadOwnedReferences(path, () => {}).read(REFERENCE)).toBeUndefined();
  });
});

test('a reference written for an image moves the tag time on its other references', () => {
  withDir((dir) => {
    const owned = loadOwnedReferences(join(dir, 'owned-references.json'), () => {});
    const later = { id: OWNED.id, taggedAt: '2026-10-04T00:00:02Z' };

    owned.write(REFERENCE, OWNED);
    owned.write('docker.io/library/busybox:1', later);

    expect(owned.read(REFERENCE)).toEqual(later);
  });
});

test('an unreadable record starts empty and says so, so nothing can be removed', () => {
  withDir((dir) => {
    const path = join(dir, 'owned-references.json');
    const logged: string[] = [];

    writeFileSync(path, '{"references": not json');

    const owned = loadOwnedReferences(path, (message) => {
      logged.push(message);
    });

    expect(owned.read(REFERENCE)).toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('no image counts as the proxy');
  });
});

test('a write that fails leaves the record as it was', () => {
  withDir((dir) => {
    const path = join(dir, 'gone', 'owned-references.json');
    const owned = loadOwnedReferences(path, () => {});

    expect(() => {
      owned.write(REFERENCE, OWNED);
    }).toThrow();

    expect(owned.read(REFERENCE)).toBeUndefined();
  });
});
