import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocCitations } from './check-doc-citations';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'doc-citations-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return { root };
}

test('it passes a citation of a page and of one of its headings', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'docs/guides/kettles.md'), '# Kettles\n\n## Descaling\n');

  await Bun.write(
    join(ctx.root, 'src/kettle.ts'),
    '// see docs/guides/kettles.md and docs/guides/kettles.md#descaling\n',
  );

  expect(checkDocCitations(ctx.root, ['src/kettle.ts'])).toStrictEqual([]);
});

test('it reports a missing page with its file and line', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'src/kettle.ts'), 'const a = 1;\n// docs/guides/teapots.md\n');

  expect(checkDocCitations(ctx.root, ['src/kettle.ts'])).toStrictEqual([
    { file: 'src/kettle.ts', line: 2, message: 'docs/guides/teapots.md does not exist' },
  ]);
});

test('it reports a missing heading on a page that exists', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'docs/guides/kettles.md'), '# Kettles\n\n## Descaling\n');
  await Bun.write(join(ctx.root, 'src/kettle.ts'), '// docs/guides/kettles.md#boiling\n');

  expect(checkDocCitations(ctx.root, ['src/kettle.ts'])).toStrictEqual([
    { file: 'src/kettle.ts', line: 1, message: 'docs/guides/kettles.md has no heading #boiling' },
  ]);
});

test.each([
  ['## The `kettle` lid', 'the-kettle-lid'],
  ['## Spouts, handles and lids', 'spouts-handles-and-lids'],
  ['## A [linked](./other.md) heading', 'a-linked-heading'],
  ['## **Bold** and _slanted_ words', 'bold-and-slanted-words'],
  ['## Salt &amp; pepper', 'salt--pepper'],
  ['## 4. Steeping: <em>green</em> tea', '4-steeping-green-tea'],
  ['## snake_case_name', 'snake_case_name'],
  ['Setext heading\n---', 'setext-heading'],
  ['<a id="custom-spot"></a>', 'custom-spot'],
])('it finds the anchor of %p as #%s', async (heading, anchor) => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'docs/page.md'), `# Page\n\n${heading}\n`);
  await Bun.write(join(ctx.root, 'src/a.ts'), `// docs/page.md#${anchor}\n`);

  expect(checkDocCitations(ctx.root, ['src/a.ts'])).toStrictEqual([]);
});

test('it numbers a repeated heading as GitHub does', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'docs/page.md'), '# Page\n\n## Notes\n\n## Notes\n');
  await Bun.write(join(ctx.root, 'src/a.ts'), '// docs/page.md#notes-1 and docs/page.md#notes-2\n');

  expect(checkDocCitations(ctx.root, ['src/a.ts'])).toStrictEqual([
    { file: 'src/a.ts', line: 1, message: 'docs/page.md has no heading #notes-2' },
  ]);
});

test('it takes no heading from a code fence or front matter', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'docs/page.md'),
    '---\n# Front\n---\n# Page\n\n```sh\n# Fenced\n```\n',
  );

  await Bun.write(join(ctx.root, 'src/a.ts'), '// docs/page.md#front docs/page.md#fenced\n');

  expect(checkDocCitations(ctx.root, ['src/a.ts'])).toStrictEqual([
    { file: 'src/a.ts', line: 1, message: 'docs/page.md has no heading #front' },
    { file: 'src/a.ts', line: 1, message: 'docs/page.md has no heading #fenced' },
  ]);
});

test('it checks a blob URL into this repo on any ref', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'docs/guides/kettles.md'), '# Kettles\n');

  await Bun.write(
    join(ctx.root, 'deploy/kettle.service'),
    [
      'Documentation=https://github.com/zgeoff/impz/blob/main/docs/guides/kettles.md',
      'Documentation=https://github.com/zgeoff/impz/blob/v2.0.0/docs/guides/teapots.md',
      '',
    ].join('\n'),
  );

  expect(checkDocCitations(ctx.root, ['deploy/kettle.service'])).toStrictEqual([
    { file: 'deploy/kettle.service', line: 2, message: 'docs/guides/teapots.md does not exist' },
  ]);
});

test('it passes over a docs folder of another path or another repo', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'src/a.ts'),
    [
      '// packages/kettle/docs/missing.md',
      '// https://github.com/someone/else/blob/main/docs/missing.md',
      '',
    ].join('\n'),
  );

  expect(checkDocCitations(ctx.root, ['src/a.ts'])).toStrictEqual([]);
});

test('it reads a cited folder and a sentence-ending full stop', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'docs/reference/protocol.md'), '# Protocol\n');

  await Bun.write(
    join(ctx.root, 'src/a.ts'),
    '// docs/reference holds it, as docs/reference/protocol.md.\n',
  );

  expect(checkDocCitations(ctx.root, ['src/a.ts'])).toStrictEqual([]);
});

test('it passes over a binary file', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'images/logo.bin'),
    new Uint8Array([0, ...new TextEncoder().encode('docs/gone.md')]),
  );

  expect(checkDocCitations(ctx.root, ['images/logo.bin'])).toStrictEqual([]);
});
