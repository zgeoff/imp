import { expect, test } from 'bun:test';
import { UsageError } from '../usage-error';
import { parseCpArgs } from './parse-cp-args';

test('it plans an upload when the target names an imp and a path', () => {
  expect(parseCpArgs('./dir', 'box:/srv/dir')).toStrictEqual({
    direction: 'upload',
    name: 'box',
    guestPath: '/srv/dir',
    localPath: './dir',
  });
});

test('it plans a download when the source names an imp and a path', () => {
  expect(parseCpArgs('box:logs/x y', '.')).toStrictEqual({
    direction: 'download',
    name: 'box',
    guestPath: 'logs/x y',
    localPath: '.',
  });
});

test('it keeps a local path local when a slash comes before its colon', () => {
  expect(parseCpArgs('./a:b', 'box:/tmp')).toStrictEqual({
    direction: 'upload',
    name: 'box',
    guestPath: '/tmp',
    localPath: './a:b',
  });
});

test('it keeps a side local when the part before its colon is no imp name', () => {
  expect(() => parseCpArgs('Not_A_Name:/a', 'b')).toThrowWithMessage(
    UsageError,
    'one side of imp cp is in an imp: imp cp ./dir box:/srv/dir, or imp cp box:/var/log/x .',
  );
});

test.each([
  ['a', 'b'],
  ['box:/a', 'other:/b'],
])('it rejects %p and %p, not exactly one side in an imp, as a usage error', (source, target) => {
  expect(() => parseCpArgs(source, target)).toThrowWithMessage(
    UsageError,
    'one side of imp cp is in an imp: imp cp ./dir box:/srv/dir, or imp cp box:/var/log/x .',
  );
});

test('it rejects an imp side with no path as a usage error', () => {
  expect(() => parseCpArgs('./a', 'box:')).toThrowWithMessage(
    UsageError,
    'name a path in the imp: box:/srv/dir, or box:dir in its home',
  );
});
