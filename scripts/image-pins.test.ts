import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The images built on the published base name it by digest, so a build
// always starts from the bytes that a release attested
const REPO_ROOT = join(import.meta.dir, '..');
const PINNED_BASE = /^FROM ghcr\.io\/zgeoff\/imp-base:[\w.\-]+@sha256:[0-9a-f]{64}$/v;

for (const path of ['images/dev/Dockerfile', 'images/examples/hello/Dockerfile']) {
  test(`${path} starts FROM the published base, pinned by digest`, () => {
    const froms = readFileSync(join(REPO_ROOT, path), 'utf8')
      .split('\n')
      .filter((line) => /^FROM\s/iv.test(line));

    expect(froms).toHaveLength(1);
    expect(froms[0]).toMatch(PINNED_BASE);
  });
}

test('dev and hello pin the same base', () => {
  const read = (path: string) =>
    readFileSync(join(REPO_ROOT, path), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('FROM '));

  expect(read('images/dev/Dockerfile')).toBe(read('images/examples/hello/Dockerfile'));
});
