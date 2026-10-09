import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateHostId } from './host-id';

function setupTest() {
  const dataDir = mkdtempSync(join(tmpdir(), 'imp-host-id-'));

  onTestFinished(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  return { dataDir };
}

test('it makes a random 32-hex-digit ID on first use', () => {
  const ctx = setupTest();

  expect(loadOrCreateHostId(ctx.dataDir)).toMatch(/^[\da-f]{32}$/v);
});

test('it keeps a new ID in the data dir, readable by its owner only', () => {
  const ctx = setupTest();
  const id = loadOrCreateHostId(ctx.dataDir);
  const path = join(ctx.dataDir, 'tailnet-names', 'host-id');

  expect(readFileSync(path, 'utf8')).toBe(`${id}\n`);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('it reads back the same ID on a later call', () => {
  const ctx = setupTest();
  const first = loadOrCreateHostId(ctx.dataDir);

  expect(loadOrCreateHostId(ctx.dataDir)).toBe(first);
});

test('it reads an ID a restart finds on disk without its surrounding whitespace', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dataDir, 'tailnet-names'));

  writeFileSync(
    join(ctx.dataDir, 'tailnet-names', 'host-id'),
    '  0123456789abcdef0123456789abcdef\n\n',
  );

  expect(loadOrCreateHostId(ctx.dataDir)).toBe('0123456789abcdef0123456789abcdef');
});
