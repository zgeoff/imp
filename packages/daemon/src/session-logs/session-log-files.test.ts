import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockGenerationMeta } from '../test-utils/build-mock-generation-meta';
import {
  findGenerationDir,
  hasTombstone,
  readSessionLogRange,
  removeGenerationDir,
  removeTombstone,
  writeTombstone,
} from './session-log-files';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'imp-session-log-files-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  // an imp's logs directory, as impd lays it out under its data dir
  return { root, sessionLogsDir: join(root, 'imps', 'x', 'session-logs') };
}

test('#findGenerationDir returns the child of the logs directory a generation names', () => {
  expect(findGenerationDir('/var/lib/imp/imps/x/session-logs', 'd'.repeat(32))).toBe(
    `/var/lib/imp/imps/x/session-logs/${'d'.repeat(32)}`,
  );
});

test.each([
  ['a slash', '/'],
  ['a backslash', '\\'],
  ['a path with a slash', 'a/b'],
  ['a path with a backslash', String.raw`a\b`],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative escape', '../../../evil'],
  ['a relative escape with backslashes', String.raw`..\..\evil`],
  ['an absolute path', '/etc/passwd'],
  ['a drive path', String.raw`C:\evil`],
  ['a NUL', '\0'],
  ['a name holding a NUL', 'a\0b'],
  ['a 4096-character name', 'x'.repeat(4096)],
  ['an empty name', ''],
  ['31 hex digits and a slash', `${'a'.repeat(31)}/`],
  ['31 hex digits and a backslash', `${'a'.repeat(31)}\\`],
  ['hex digits that climb out and back', `${'a'.repeat(16)}/../${'a'.repeat(13)}`],
  ['31 hex digits after a slash', `/${'a'.repeat(31)}`],
  ['31 hex digits and a NUL', `${'a'.repeat(31)}\0`],
  ['31 hex digits', 'a'.repeat(31)],
  ['33 hex digits', 'a'.repeat(33)],
  ['32 uppercase hex digits', 'A'.repeat(32)],
  ['32 letters past f', 'g'.repeat(32)],
  ['a boot id', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a generation with a parent step after it', `${'d'.repeat(32)}/..`],
])('#findGenerationDir refuses %s', (_label, generation) => {
  expect(() =>
    findGenerationDir('/var/lib/imp/imps/x/session-logs', generation),
  ).toThrowWithMessage(Error, `session log: ${JSON.stringify(generation)} is not a generation`);
});

test.each([
  ['a slash', '/'],
  ['a path with a slash', 'a/b'],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative escape', '../../../evil'],
  ['an absolute path', '/etc/passwd'],
  ['a NUL', '\0'],
  ['an empty name', ''],
  ['hex digits that climb out and back', `${'a'.repeat(16)}/../${'a'.repeat(13)}`],
  ['31 hex digits', 'a'.repeat(31)],
  ['32 uppercase hex digits', 'A'.repeat(32)],
])('#writeTombstone refuses %s and writes nothing', async (_label, generation) => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.sessionLogsDir, 'd'.repeat(32)), { recursive: true });
  writeFileSync(join(ctx.sessionLogsDir, 'd'.repeat(32), 'meta.json'), '{}');
  writeFileSync(join(ctx.root, 'evil'), 'kept');

  expect(() => {
    writeTombstone(ctx.sessionLogsDir, generation);
  }).toThrowWithMessage(Error, `session log: ${JSON.stringify(generation)} is not a generation`);

  expect(readdirSync(ctx.root, { recursive: true, encoding: 'utf8' }).toSorted()).toStrictEqual([
    'evil',
    'imps',
    'imps/x',
    'imps/x/session-logs',
    `imps/x/session-logs/${'d'.repeat(32)}`,
    `imps/x/session-logs/${'d'.repeat(32)}/meta.json`,
  ]);
});

test.each([
  ['a slash', '/'],
  ['a path with a slash', 'a/b'],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative escape', '../../../evil'],
  ['an absolute path', '/etc/passwd'],
  ['a NUL', '\0'],
  ['an empty name', ''],
  ['hex digits that climb out and back', `${'a'.repeat(16)}/../${'a'.repeat(13)}`],
  ['31 hex digits', 'a'.repeat(31)],
  ['32 uppercase hex digits', 'A'.repeat(32)],
])('#removeTombstone refuses %s and removes nothing', async (_label, generation) => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.sessionLogsDir, 'd'.repeat(32)), { recursive: true });
  writeFileSync(join(ctx.sessionLogsDir, 'd'.repeat(32), 'meta.json'), '{}');
  writeFileSync(join(ctx.root, 'evil'), 'kept');

  expect(() => {
    removeTombstone(ctx.sessionLogsDir, generation);
  }).toThrowWithMessage(Error, `session log: ${JSON.stringify(generation)} is not a generation`);

  expect(readdirSync(ctx.root, { recursive: true, encoding: 'utf8' }).toSorted()).toStrictEqual([
    'evil',
    'imps',
    'imps/x',
    'imps/x/session-logs',
    `imps/x/session-logs/${'d'.repeat(32)}`,
    `imps/x/session-logs/${'d'.repeat(32)}/meta.json`,
  ]);
});

test.each([
  ['a slash', '/'],
  ['a path with a slash', 'a/b'],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative escape', '../../../evil'],
  ['an absolute path', '/etc/passwd'],
  ['a NUL', '\0'],
  ['an empty name', ''],
  ['hex digits that climb out and back', `${'a'.repeat(16)}/../${'a'.repeat(13)}`],
  ['31 hex digits', 'a'.repeat(31)],
  ['32 uppercase hex digits', 'A'.repeat(32)],
])('#removeGenerationDir refuses %s and removes nothing', async (_label, generation) => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.sessionLogsDir, 'd'.repeat(32)), { recursive: true });
  writeFileSync(join(ctx.sessionLogsDir, 'd'.repeat(32), 'meta.json'), '{}');
  writeFileSync(join(ctx.root, 'evil'), 'kept');

  expect(() => {
    removeGenerationDir(ctx.sessionLogsDir, generation);
  }).toThrowWithMessage(Error, `session log: ${JSON.stringify(generation)} is not a generation`);

  expect(readdirSync(ctx.root, { recursive: true, encoding: 'utf8' }).toSorted()).toStrictEqual([
    'evil',
    'imps',
    'imps/x',
    'imps/x/session-logs',
    `imps/x/session-logs/${'d'.repeat(32)}`,
    `imps/x/session-logs/${'d'.repeat(32)}/meta.json`,
  ]);
});

test.each([
  ['a slash', '/'],
  ['a path with a slash', 'a/b'],
  ['the parent directory', '..'],
  ['a relative escape', '../../../evil'],
  ['an absolute path', '/etc/passwd'],
  ['a NUL', '\0'],
  ['an empty name', ''],
  ['31 hex digits', 'a'.repeat(31)],
])('#hasTombstone answers false for %s', async (_label, generation) => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.sessionLogsDir, '.deleted'), { recursive: true });
  writeFileSync(join(ctx.root, 'evil'), 'kept');

  expect(hasTombstone(ctx.sessionLogsDir, generation)).toBe(false);
});

test('#hasTombstone finds the tombstone of a deleted generation', async () => {
  const ctx = await setupTest();

  writeTombstone(ctx.sessionLogsDir, 'd'.repeat(32));

  expect(hasTombstone(ctx.sessionLogsDir, 'd'.repeat(32))).toBe(true);
});

test('#readSessionLogRange reads a segment the bound removed between the plan and the read as a gap', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.sessionLogsDir, 'd'.repeat(32));

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '100.seg'), 'later');

  // the first look still counts the segment at 0, whose file has gone
  const fresh = buildMockGenerationMeta({
    session: 'main',
    executionGeneration: 'd'.repeat(32),
    segments: [{ start: 100, length: 5 }],
  });

  const looks = [
    {
      ...fresh,
      segments: [
        { start: 0, length: 100 },
        { start: 100, length: 5 },
      ],
    },
  ];

  const read = await readSessionLogRange(ctx.sessionLogsDir, () => looks.shift() ?? fresh, {
    session: 'main',
    executionGeneration: 'd'.repeat(32),
    from: 10,
  });

  const text = await read.data.text();

  expect(read.offset).toBe(100);
  expect(read.gap).toStrictEqual({ from: 10, to: 100 });
  expect(text).toBe('later');
});

test('#readSessionLogRange rejects a session that has no log of the generation', async () => {
  const ctx = await setupTest();

  const meta = buildMockGenerationMeta({ session: 'main', executionGeneration: 'd'.repeat(32) });

  expect(
    readSessionLogRange(ctx.sessionLogsDir, () => meta, {
      session: 'other',
      executionGeneration: 'd'.repeat(32),
      from: 0,
    }),
  ).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: `no log of session other generation ${'d'.repeat(32)}`,
    data: { kind: 'session', name: 'other' },
  });
});

test('#readSessionLogRange rejects a read past the end of the log', async () => {
  const ctx = await setupTest();

  const meta = buildMockGenerationMeta({
    session: 'main',
    executionGeneration: 'd'.repeat(32),
    segments: [{ start: 4, length: 6 }],
  });

  expect(
    readSessionLogRange(ctx.sessionLogsDir, () => meta, {
      session: 'main',
      executionGeneration: 'd'.repeat(32),
      from: 11,
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_RESUME',
    message: 'offset 11 is past the end of the log, 10',
    data: { end: 10, bufferStart: 4 },
  });
});

test('#readSessionLogRange rejects a segment file shorter than its meta counts', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.sessionLogsDir, 'd'.repeat(32));

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '0.seg'), 'abc');

  const meta = buildMockGenerationMeta({
    session: 'main',
    executionGeneration: 'd'.repeat(32),
    segments: [{ start: 0, length: 10 }],
  });

  expect(
    readSessionLogRange(ctx.sessionLogsDir, () => meta, {
      session: 'main',
      executionGeneration: 'd'.repeat(32),
      from: 0,
    }),
  ).rejects.toThrowWithMessage(Error, 'session log: read 3 of 10 bytes');
});
