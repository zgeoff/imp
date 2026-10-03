import { expect, test } from 'bun:test';
import { formatPolicy, parsePolicy } from './parse-policy';

test('a mode, an allow-list alone as box, or nothing at all', () => {
  expect(parsePolicy(undefined, undefined)).toBeUndefined();
  expect(parsePolicy('open', undefined)).toEqual({ mode: 'open', allow: [] });
  expect(parsePolicy('public', undefined)).toEqual({ mode: 'public', allow: [] });

  expect(parsePolicy('box', 'GitHub.com, *.npmjs.org,')).toEqual({
    mode: 'box',
    allow: ['github.com', '*.npmjs.org'],
  });

  expect(parsePolicy(undefined, '9.9.9.9')).toEqual({ mode: 'box', allow: ['9.9.9.9'] });
});

test('an unknown mode, or a list for open or none, is a usage error', () => {
  expect(() => parsePolicy('closed', undefined)).toThrow('open, public, box or none, not closed');

  expect(() => parsePolicy('public', '10.0.0.0/8')).toThrow(
    '--allow is for a box policy, not public',
  );

  expect(() => parsePolicy('none', 'github.com')).toThrow('--allow is for a box policy, not none');
});

test('a box shows its list', () => {
  expect(formatPolicy({ mode: 'box', allow: ['github.com', '*.npmjs.org'] })).toBe(
    'box: github.com, *.npmjs.org',
  );

  expect(formatPolicy({ mode: 'box', allow: [] })).toBe('box: (nothing)');
  expect(formatPolicy({ mode: 'none', allow: [] })).toBe('none');
});
