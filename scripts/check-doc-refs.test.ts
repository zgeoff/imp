import { expect, test } from 'bun:test';
import { buildAnchor, checkFile, readAnchors } from './check-doc-refs';

const PAGE = [
  '# Sleep and wake',
  '## The RAM governor',
  '### 4. Gotchas',
  '### sessions: detachable consoles',
  '## `exec`',
  '```sh',
  '# not a heading',
  '```',
  '## Sleep',
  '## Sleep',
].join('\n');

function readPage(path: string): string | null {
  return path === 'docs/architecture/sleep-and-wake.md' ? PAGE : null;
}

test('buildAnchor follows GitHub anchors', () => {
  expect(buildAnchor('4. Gotchas')).toBe('4-gotchas');
  expect(buildAnchor('sessions: detachable consoles')).toBe('sessions-detachable-consoles');
  expect(buildAnchor('`exec`')).toBe('exec');
  expect(buildAnchor('Checkpoints, restores and forks')).toBe('checkpoints-restores-and-forks');
});

test('readAnchors numbers repeats and skips fenced code', () => {
  const anchors = readAnchors(PAGE);

  expect(anchors.has('sleep')).toBe(true);
  expect(anchors.has('sleep-1')).toBe(true);
  expect(anchors.has('not-a-heading')).toBe(false);
});

test('a reference to an existing page and anchor passes', () => {
  const text = [
    '// see docs/architecture/sleep-and-wake.md#the-ram-governor',
    '// and docs/architecture/sleep-and-wake.md, the whole page',
  ].join('\n');

  expect(checkFile('a.ts', text, readPage)).toEqual([]);
});

test('a missing page or anchor fails with its line', () => {
  const text = [
    '// fine',
    '// docs/guides/gone.md',
    '# docs/architecture/sleep-and-wake.md#no-such-heading',
  ].join('\n');

  expect(checkFile('a.sh', text, readPage)).toEqual([
    { file: 'a.sh', line: 2, message: 'docs/guides/gone.md does not exist' },
    {
      file: 'a.sh',
      line: 3,
      message: 'docs/architecture/sleep-and-wake.md has no heading #no-such-heading',
    },
  ]);
});

test('the removed docs fail anywhere, Markdown included', () => {
  const removed = ['DESIGN.md', 'DESIGN 2.8', 'agent/PROTOCOL.md', 'docs/sleep-findings.md'];

  for (const name of removed) {
    expect(checkFile('notes.md', `see ${name}`, readPage)).toHaveLength(1);
  }
});

test('a quoted heading fails: it cannot be checked', () => {
  const text = '// see docs/architecture/sleep-and-wake.md ("Sleep")';

  expect(checkFile('a.ts', text, readPage)).toEqual([
    {
      file: 'a.ts',
      line: 1,
      message: 'names a heading in quotes; use docs/<page>.md#<anchor>',
    },
  ]);
});

test('Markdown links are left to the page', () => {
  expect(checkFile('README.md', '[x](docs/guides/gone.md)', readPage)).toEqual([]);
});
