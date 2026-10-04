import { expect, test } from 'bun:test';
import { listForkWarnings } from './imps';

type Fork = Parameters<typeof listForkWarnings>[1];

function buildFork(fields: Omit<Fork, 'name'>): Fork {
  return { name: 'dev-b', ...fields };
}

test('a fork names each grant it did not get, and a copy that failed as a whole', () => {
  const skipped = buildFork({
    grantsNotCopied: [
      { secret: 'gh', reason: 'not-grantable' },
      { secret: 'npm', reason: 'clash' },
    ],
  });

  const failed = buildFork({ grantsNotCopied: [], grantsError: 'the copy failed' });

  expect(listForkWarnings('dev-a', skipped)).toEqual([
    'dev-b: grant gh of dev-a not copied: not-grantable',
    'dev-b: grant npm of dev-a not copied: clash',
  ]);

  expect(listForkWarnings('dev-a', failed)).toEqual(['dev-b: the copy failed']);
});

test('a fork from an impd before the report warns of nothing', () => {
  expect(listForkWarnings('dev-a', buildFork({}))).toEqual([]);
});
