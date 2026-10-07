import { expect, test } from 'bun:test';
import { formatPolicy, parsePolicy } from './parse-policy';
import { UsageError } from './usage-error';

test('#parsePolicy leaves the policy unset when neither flag is given', () => {
  expect(parsePolicy(undefined, undefined)).toBeUndefined();
});

test.each(['open', 'public', 'box', 'none'])(
  '#parsePolicy reads the mode %p with an empty allow-list',
  (mode) => {
    expect(parsePolicy(mode, undefined)).toStrictEqual({ mode, allow: [] });
  },
);

test('#parsePolicy lowercases, trims and drops empty entries of a box allow-list', () => {
  expect(parsePolicy('box', 'GitHub.com, *.npmjs.org,')).toStrictEqual({
    mode: 'box',
    allow: ['github.com', '*.npmjs.org'],
  });
});

test('#parsePolicy reads an allow-list alone as a box policy', () => {
  expect(parsePolicy(undefined, '9.9.9.9')).toStrictEqual({ mode: 'box', allow: ['9.9.9.9'] });
});

test('#parsePolicy rejects an unknown mode as a usage error', () => {
  expect(() => parsePolicy('closed', undefined)).toThrowWithMessage(
    UsageError,
    'the egress policy is open, public, box or none, not closed',
  );
});

test.each(['open', 'public', 'none'])(
  '#parsePolicy rejects an allow-list for the mode %p as a usage error',
  (mode) => {
    expect(() => parsePolicy(mode, 'github.com')).toThrowWithMessage(
      UsageError,
      `--allow is for a box policy, not ${mode}`,
    );
  },
);

test('#formatPolicy shows a box policy with its allow-list', () => {
  expect(formatPolicy({ mode: 'box', allow: ['github.com', '*.npmjs.org'] })).toBe(
    'box: github.com, *.npmjs.org',
  );
});

test('#formatPolicy shows a box policy with an empty allow-list as nothing', () => {
  expect(formatPolicy({ mode: 'box', allow: [] })).toBe('box: (nothing)');
});

test('#formatPolicy shows another policy by its mode alone', () => {
  expect(formatPolicy({ mode: 'none', allow: [] })).toBe('none');
});
