import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// An image built on the published base names it by digest, so a build always starts from the
// bytes that a release attested.
test('it starts from the published base, pinned by digest', () => {
  const froms = readFileSync(new URL('hello/Dockerfile', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => /^FROM\s/iv.test(line));

  expect(froms).toHaveLength(1);
  expect(froms[0]).toMatch(/^FROM ghcr\.io\/zgeoff\/imp-base:[\w.\-]+@sha256:[0-9a-f]{64}$/v);
});
