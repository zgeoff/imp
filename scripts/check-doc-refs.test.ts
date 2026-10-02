import { expect, test } from 'bun:test';
import { buildAnchor, checkFile, readAnchors } from './check-doc-refs';
import type { Repo } from './check-doc-refs';

const SLEEP = 'docs/architecture/sleep-and-wake.md';

const PAGE = [
  '# Sleep and wake',
  '## The RAM governor',
  '### 4. Gotchas',
  '### sessions: detachable consoles',
  '```sh',
  '# 1. not a heading',
  '```',
  '## Sleep',
  '## Sleep',
].join('\n');

const PAGES = new Map([
  [SLEEP, PAGE],
  ['docs/architecture/sub/page.md', '# Page'],
]);

const repo: Repo = {
  exists: (path) => PAGES.has(path) || path === 'docs/guides' || path === 'LICENSE',
  readPage: (path) => PAGES.get(path) ?? null,
};

function readMessages(file: string, text: string): string[] {
  return checkFile(file, text, repo).map((problem) => problem.message);
}

test('buildAnchor follows GitHub anchors', () => {
  expect(buildAnchor('4. Gotchas')).toBe('4-gotchas');
  expect(buildAnchor('sessions: detachable consoles')).toBe('sessions-detachable-consoles');
  expect(buildAnchor('`freeze` / `thaw`')).toBe('freeze--thaw');
  expect(buildAnchor('[The manifest](./x.md) and more')).toBe('the-manifest-and-more');
  expect(buildAnchor('Checkpoints, restores and forks')).toBe('checkpoints-restores-and-forks');
});

test('readAnchors numbers repeats and skips fenced code', () => {
  const anchors = readAnchors(PAGE);

  expect(anchors.has('sleep')).toBe(true);
  expect(anchors.has('sleep-1')).toBe(true);
  expect(anchors.has('1-not-a-heading')).toBe(false);
});

test('code references to existing pages and anchors pass', () => {
  const text = [
    `// see ${SLEEP}#the-ram-governor and ${SLEEP}#4-gotchas, gotcha 8`,
    '// README.md and CHANGELOG.md are no docs pages',
  ].join('\n');

  expect(readMessages('a.ts', text)).toEqual([]);
});

test('a missing page or anchor fails with its line', () => {
  const text = ['// fine', '// docs/guides/gone.md', `# ${SLEEP}#no-such-heading`].join('\n');

  expect(checkFile('a.sh', text, repo)).toEqual([
    { file: 'a.sh', line: 2, message: 'docs/guides/gone.md does not exist' },
    { file: 'a.sh', line: 3, message: `${SLEEP} has no heading #no-such-heading` },
  ]);
});

test('a docs page named without its path fails, with or without an anchor', () => {
  const message = 'names sleep-and-wake.md without its path; use docs/<area>/sleep-and-wake.md';

  expect(readMessages('a.ts', '// sleep-and-wake.md#sleep')).toEqual([message]);
  expect(readMessages('a.ts', '// (sleep-and-wake.md)')).toEqual([message]);
});

test('a docs path split after its folder fails', () => {
  expect(readMessages('a.ts', '// the layout (docs/architecture/\n// storage.md)')).toEqual([
    'splits a docs path across lines; use docs/<page>.md#<anchor>',
  ]);
});

test('headings named only in prose fail', () => {
  const lines = [
    `// ${SLEEP} ("Sleep")`,
    `// ${SLEEP}, "Sleep"`,
    `// (${SLEEP}, gotcha 6)`,
    `// (${SLEEP}, Sleep)`,
    '// (docs/architecture/',
  ];

  for (const line of lines) {
    expect(readMessages('a.ts', line)).toHaveLength(1);
  }
});

test('the removed docs fail anywhere, Markdown included', () => {
  const removed = ['DESIGN.md', 'DESIGN 2.8', 'agent/PROTOCOL.md', 'sleep-findings'];

  for (const name of removed) {
    expect(readMessages('notes.md', `see ${name}`)).toEqual([
      'cites a removed doc; point it at docs/',
    ]);
  }
});

test('Markdown links resolve against the page', () => {
  const text = [
    '[ok](../sleep-and-wake.md#sleep) [top](#page) [dir](../../guides/) [web](https://x.dev)',
    '[gone](./gone.md) [bad](#nope) <a href="./also-gone.md">x</a>',
  ].join('\n');

  expect(readMessages('docs/architecture/sub/page.md', text)).toEqual([
    'docs/architecture/sub/gone.md does not exist',
    'docs/architecture/sub/page.md has no heading #nope',
    'docs/architecture/sub/also-gone.md does not exist',
  ]);
});

test('blob URLs into this repo must exist', () => {
  const text = [
    'Documentation=https://github.com/zgeoff/imp/blob/main/LICENSE',
    'see https://github.com/zgeoff/imp/blob/main/docs/guides/gone.md',
  ].join('\n');

  expect(readMessages('imp-host.service', text)).toEqual(['docs/guides/gone.md does not exist']);
});
