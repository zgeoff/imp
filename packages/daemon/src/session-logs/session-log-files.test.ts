import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerationMeta } from './generation-log';
import { findGenerationDir, readSessionLogRange } from './session-log-files';

const GENERATION = 'd'.repeat(32);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildMeta(segments: GenerationMeta['segments']): GenerationMeta {
  return {
    version: 1,
    session: 'main',
    executionGeneration: GENERATION,
    bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    startedAt: 1,
    origin: 0,
    segments,
    state: 'live',
  };
}

test('only a child of the logs directory named as a generation is a log', () => {
  const root = '/var/lib/imp/imps/x/session-logs';

  expect(findGenerationDir(root, GENERATION)).toBe(join(root, GENERATION));

  for (const hostile of ['../../evil', '..', '.', '', `${GENERATION}/..`, 'D'.repeat(32)]) {
    expect(() => findGenerationDir(root, hostile)).toThrow('is not a generation');
  }
});

test('a segment the bound removed between the plan and the read reads as a gap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imp-session-log-files-'));

  dirs.push(root);

  const dir = join(root, GENERATION);

  mkdirSync(dir);
  writeFileSync(join(dir, '100.seg'), 'later');

  // the first look still counts the segment at 0, whose file has gone
  const looks = [
    buildMeta([
      { start: 0, length: 100 },
      { start: 100, length: 5 },
    ]),
    buildMeta([{ start: 100, length: 5 }]),
  ];

  let count = 0;

  const read = await readSessionLogRange(root, () => looks[Math.min(count++, 1)] ?? null, {
    session: 'main',
    executionGeneration: GENERATION,
    from: 10,
  });

  expect(read.offset).toBe(100);
  expect(read.gap).toEqual({ from: 10, to: 100 });

  const text = await read.data.text();

  expect(text).toBe('later');
});
