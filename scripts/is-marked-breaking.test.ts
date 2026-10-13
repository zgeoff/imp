import { expect, test } from 'bun:test';
import { isMarkedBreaking } from './is-marked-breaking';

// Each row's verdict is release-please 17.11.2's parseConventionalCommits on
// the squash message GitHub builds for it.
test.each([
  ['a lone commit with a ! subject', 'feat: a', ['feat(api)!: drop imps.get'], '', true],
  ['a lone commit of any type with a ! subject', 'chore: a', ['chore!: drop imps.get'], '', true],
  ['a lone commit under a ! PR title', 'feat!: drop imps.get', ['feat: drop imps.get'], '', false],
  [
    'several commits under a ! PR title',
    'feat(#740)!: drop imps.get',
    ['feat: a', 'fix: b'],
    '',
    true,
  ],
  ['several commits with ! on a later one only', 'feat: a', ['feat: a', 'feat!: b'], '', false],
  [
    'a footer in a lone commit',
    'feat: a',
    ['feat: a\n\nBREAKING CHANGE: imps.get is gone'],
    '',
    true,
  ],
  [
    'a footer in an earlier commit of several',
    'feat: a',
    ['feat: a\n\nBREAKING CHANGE: gone', 'fix: b'],
    '',
    true,
  ],
  [
    'a footer with no space after the colon',
    'feat: a',
    ['feat: a\n\nBREAKING CHANGE:gone'],
    '',
    true,
  ],
  ['a footer with no text', 'feat: a', ['feat: a\n\nBREAKING CHANGE: '], '', false],
  ['the words mid-line', 'feat: a', ['feat: a\n\nsee the BREAKING CHANGE: inline'], '', false],
  [
    'the hyphenated token mid-line',
    'feat: a',
    ['feat: a\n\nthis has BREAKING-CHANGE: x inline'],
    '',
    true,
  ],
  ['a footer in lower case', 'feat: a', ['feat: a\n\nbreaking change: gone'], '', false],
  [
    'an override in the PR body',
    'feat: a',
    ['feat: a'],
    'BEGIN_COMMIT_OVERRIDE\nfeat!: drop imps.get\nEND_COMMIT_OVERRIDE',
    true,
  ],
  [
    'an override that hides a ! commit',
    'feat: a',
    ['feat!: a'],
    'BEGIN_COMMIT_OVERRIDE\nfeat: a\nEND_COMMIT_OVERRIDE',
    false,
  ],
  ['a plain feat', 'feat: add imps.list', ['feat: add imps.list'], '', false],
])('it judges %s', (_label, title, commits, body, expected) => {
  expect(isMarkedBreaking({ number: 5, title, body, commits })).toBe(expected);
});
