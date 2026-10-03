import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOwnedImages } from './owned-images';

const ID = `sha256:${'a'.repeat(64)}`;

test('the set outlives a restart, in a file only the proxy reads, with no temp file left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-owned-images-'));
  const path = join(dir, 'owned-images.json');

  try {
    const owned = loadOwnedImages(path);

    expect(owned.has(ID)).toBe(false);

    owned.add(ID);

    expect(loadOwnedImages(path).has(ID)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    owned.remove(ID);

    expect(loadOwnedImages(path).has(ID)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{"ids":[]}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
