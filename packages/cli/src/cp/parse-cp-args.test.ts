import { expect, test } from 'bun:test';
import { parseCpArgs } from './parse-cp-args';

test('the side with an imp name and a colon is in the imp', () => {
  expect(parseCpArgs('./dir', 'box:/srv/dir')).toEqual({
    direction: 'upload',
    name: 'box',
    guestPath: '/srv/dir',
    localPath: './dir',
  });

  expect(parseCpArgs('box:logs/x y', '.')).toEqual({
    direction: 'download',
    name: 'box',
    guestPath: 'logs/x y',
    localPath: '.',
  });
});

test('a local path with a colon after a slash stays local', () => {
  expect(parseCpArgs('./a:b', 'box:/tmp')).toMatchObject({
    direction: 'upload',
    localPath: './a:b',
  });
});

test('both sides local, both in imps, or no guest path is a usage error', () => {
  for (const [source, target] of [
    ['a', 'b'],
    ['box:/a', 'other:/b'],
    ['./a', 'box:'],
  ] as const) {
    expect(() => parseCpArgs(source, target)).toThrow(/imp cp|name a path/v);
  }
});
