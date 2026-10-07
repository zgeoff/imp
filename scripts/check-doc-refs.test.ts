import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAnchor, checkFile, readAnchors } from './check-doc-refs';
import { buildStubDocRepo } from './test-utils/build-stub-doc-repo';

function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-doc-refs-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    dir,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test.each([
  ['4. Gotchas', '4-gotchas'],
  ['sessions: detachable consoles', 'sessions-detachable-consoles'],
  ['`freeze` / `thaw`', 'freeze--thaw'],
  ['[The manifest](./x.md) and more', 'the-manifest-and-more'],
  ['Checkpoints, restores and forks', 'checkpoints-restores-and-forks'],
])('#buildAnchor gives the heading %p the GitHub anchor %p', (heading, anchor) => {
  expect(buildAnchor(heading)).toBe(anchor);
});

test('#readAnchors numbers a repeated heading and skips headings in fenced code', () => {
  const page = ['# Sleep and wake', '```sh', '# 1. not a heading', '```', '## Sleep', '## Sleep'];

  expect(readAnchors(page.join('\n'))).toStrictEqual(
    new Set(['sleep-and-wake', 'sleep', 'sleep-1']),
  );
});

test('#checkFile passes code references to pages and anchors that exist', () => {
  const repo = buildStubDocRepo({
    pages: {
      'docs/architecture/sleep-and-wake.md':
        '# Sleep and wake\n## The RAM governor\n### 4. Gotchas',
    },
  });

  const text = [
    '// see docs/architecture/sleep-and-wake.md#the-ram-governor and',
    '// docs/architecture/sleep-and-wake.md#4-gotchas, gotcha 8',
    '// README.md and CHANGELOG.md are no docs pages',
  ].join('\n');

  expect(checkFile('a.ts', text, repo)).toStrictEqual([]);
});

test('#checkFile fails a missing page and a missing anchor, each with its line', () => {
  const repo = buildStubDocRepo({
    pages: { 'docs/architecture/sleep-and-wake.md': '# Sleep and wake' },
    paths: ['docs/guides'],
  });

  const text = [
    '// fine',
    '// docs/guides/gone.md',
    '# docs/architecture/sleep-and-wake.md#no-such-heading',
  ].join('\n');

  expect(checkFile('a.sh', text, repo)).toStrictEqual([
    { file: 'a.sh', line: 2, message: 'docs/guides/gone.md does not exist' },
    {
      file: 'a.sh',
      line: 3,
      message: 'docs/architecture/sleep-and-wake.md has no heading #no-such-heading',
    },
  ]);
});

test.each([['// sleep-and-wake.md#sleep'], ['// (sleep-and-wake.md)']])(
  '#checkFile fails a docs page named without its path in %p',
  (line) => {
    const repo = buildStubDocRepo({
      pages: { 'docs/architecture/sleep-and-wake.md': '# Sleep and wake\n## Sleep' },
    });

    expect(checkFile('a.ts', line, repo)).toStrictEqual([
      {
        file: 'a.ts',
        line: 1,
        message: 'names sleep-and-wake.md without its path; use docs/<area>/sleep-and-wake.md',
      },
    ]);
  },
);

test('#checkFile fails a docs path split after its folder', () => {
  const repo = buildStubDocRepo({ pages: {} });

  expect(
    checkFile('a.ts', '// the layout (docs/architecture/\n// storage.md)', repo),
  ).toStrictEqual([
    {
      file: 'a.ts',
      line: 1,
      message: 'splits a docs path across lines; use docs/<page>.md#<anchor>',
    },
  ]);
});

test.each([
  ['// docs/architecture/sleep-and-wake.md ("Sleep")', 'names a heading in quotes'],
  ['// docs/architecture/sleep-and-wake.md, "Sleep"', 'names a heading in quotes'],
  ['// (docs/architecture/sleep-and-wake.md, gotcha 6)', 'names a section in prose'],
  ['// (docs/architecture/sleep-and-wake.md, Sleep)', 'names a heading after a comma'],
  ['// (docs/architecture/', 'splits a docs path across lines'],
])('#checkFile fails the heading named only in prose in %p', (line, problem) => {
  const repo = buildStubDocRepo({
    pages: { 'docs/architecture/sleep-and-wake.md': '# Sleep and wake\n## Sleep' },
  });

  expect(checkFile('a.ts', line, repo)).toStrictEqual([
    { file: 'a.ts', line: 1, message: `${problem}; use docs/<page>.md#<anchor>` },
  ]);
});

test.each([['DESIGN.md'], ['DESIGN 2.8'], ['agent/PROTOCOL.md'], ['sleep-findings']])(
  '#checkFile fails the removed doc %p, in Markdown too',
  (name) => {
    const repo = buildStubDocRepo({ pages: {} });

    expect(checkFile('notes.md', `see ${name}`, repo)).toStrictEqual([
      { file: 'notes.md', line: 1, message: 'cites a removed doc; point it at docs/' },
    ]);
  },
);

test('#checkFile resolves Markdown links against the page', () => {
  const repo = buildStubDocRepo({
    pages: {
      'docs/architecture/sleep-and-wake.md': '# Sleep and wake\n## Sleep',
      'docs/architecture/sub/page.md': '# Page',
    },
    paths: ['docs/guides'],
  });

  const text = [
    '[ok](../sleep-and-wake.md#sleep) [top](#page) [dir](../../guides/) [web](https://x.dev)',
    '[gone](./gone.md) [bad](#nope) <a href="./also-gone.md">x</a>',
  ].join('\n');

  expect(checkFile('docs/architecture/sub/page.md', text, repo)).toStrictEqual([
    {
      file: 'docs/architecture/sub/page.md',
      line: 2,
      message: 'docs/architecture/sub/gone.md does not exist',
    },
    {
      file: 'docs/architecture/sub/page.md',
      line: 2,
      message: 'docs/architecture/sub/page.md has no heading #nope',
    },
    {
      file: 'docs/architecture/sub/page.md',
      line: 2,
      message: 'docs/architecture/sub/also-gone.md does not exist',
    },
  ]);
});

test('#checkFile fails a blob URL into this repo whose file does not exist', () => {
  const repo = buildStubDocRepo({ pages: {}, paths: ['LICENSE', 'docs/guides'] });

  const text = [
    'Documentation=https://github.com/zgeoff/imp/blob/main/LICENSE',
    'see https://github.com/zgeoff/imp/blob/main/docs/guides/gone.md',
  ].join('\n');

  expect(checkFile('imp-host.service', text, repo)).toStrictEqual([
    { file: 'imp-host.service', line: 2, message: 'docs/guides/gone.md does not exist' },
  ]);
});

test('#main fails the run when git cannot list the tracked files', () => {
  using ctx = setupTest();

  const result = Bun.spawnSync(['bun', new URL('check-doc-refs.ts', import.meta.url).pathname], {
    cwd: ctx.dir,
    env: { PATH: process.env['PATH'] ?? '', GIT_CEILING_DIRECTORIES: ctx.dir },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toInclude('git ls-files failed');
});
