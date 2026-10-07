import { expect, test } from 'bun:test';
import { buildUnshare } from './build-unshare';

test.each([
  [false, 1000, ['unshare', '-rn']],
  [false, 0, ['unshare', '-n']],
  [true, 1000, ['unshare', '-rnm', '--propagation', 'private']],
  [true, 0, ['unshare', '-nm', '--propagation', 'private']],
])('it builds the unshare argv for mount %p as uid %p', (mount, uid, expected) => {
  expect(buildUnshare({ mount, uid })).toStrictEqual(expected);
});

test('it adds a user namespace when the uid is unknown', () => {
  expect(buildUnshare({ mount: false, uid: undefined })).toStrictEqual(['unshare', '-rn']);
});
