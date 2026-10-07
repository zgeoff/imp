import { expect, test } from 'bun:test';
import { GuardError, createImpGuard, createPatternGuard } from './imp-guard';

test('#createImpGuard refuses a guard with no prefix, allow-list or --all', () => {
  expect(() => createImpGuard({})).toThrowWithMessage(
    GuardError,
    'choose the imps this server may touch: --prefix, --allow or --all',
  );
});

test('#createImpGuard refuses --all together with a prefix', () => {
  expect(() => createImpGuard({ all: true, prefix: 'a-' })).toThrowWithMessage(
    GuardError,
    '--all allows every imp; leave out --prefix and --allow',
  );
});

test('#createImpGuard refuses --all together with an allow-list', () => {
  expect(() => createImpGuard({ all: true, allow: ['a'] })).toThrowWithMessage(
    GuardError,
    '--all allows every imp; leave out --prefix and --allow',
  );
});

test.each([['Agent-'], ['-x'], ['aaaaaaaaaaaaaaaaaaaaaaaa']])(
  '#createImpGuard refuses the prefix %s',
  (prefix) => {
    expect(() => createImpGuard({ prefix })).toThrowWithMessage(
      GuardError,
      `--prefix ${prefix}: must start with a lowercase letter, hold only lowercase letters, digits and hyphens, and be at most 23 characters`,
    );
  },
);

test('#createImpGuard picks a 31-character name under the longest prefix it takes', () => {
  const guard = createImpGuard({ prefix: 'aaaaaaaaaaaaaaaaaaaaaaa' });
  const name = guard.pickNewName();

  expect(name).toMatch(/^a{23}[a-z0-9]{8}$/);
});

test('#createImpGuard refuses an allow-list that holds an invalid name', () => {
  expect(() => createImpGuard({ allow: ['ok', 'Not Ok'] })).toThrowWithMessage(
    GuardError,
    '--allow: Not Ok is not a valid imp name',
  );
});

test.each([
  ['agent-x', true],
  ['shared', true],
  ['shared2', false],
  ['agent', false],
])('#createImpGuard answers %s with %p under a prefix and an allow-list', (name, allowed) => {
  const guard = createImpGuard({ prefix: 'agent-', allow: ['shared'] });

  expect(guard.isAllowed(name)).toBe(allowed);
});

test('#createImpGuard names both the prefix and the allow-list in its summary', () => {
  const guard = createImpGuard({ prefix: 'agent-', allow: ['shared'] });

  expect(guard.summary).toBe('imps named agent-* and the imps shared');
});

test('#createImpGuard passes an imp inside the guard', () => {
  const guard = createImpGuard({ prefix: 'agent-', allow: ['shared'] });

  expect(() => {
    guard.require('agent-x');
  }).not.toThrow();
});

test('#createImpGuard refuses an imp outside the guard with the summary', () => {
  const guard = createImpGuard({ prefix: 'agent-', allow: ['shared'] });

  expect(() => {
    guard.require('prod');
  }).toThrowWithMessage(
    GuardError,
    "imp prod is outside this server's guard: imps named agent-* and the imps shared",
  );
});

test('#createImpGuard allows every imp under --all', () => {
  const guard = createImpGuard({ all: true });

  expect(guard.isAllowed('anything')).toBeTrue();
});

test('#createImpGuard leaves the new name to impd under --all', () => {
  const guard = createImpGuard({ all: true });

  expect(guard.pickNewName()).toBeNull();
});

test('#createImpGuard summarises --all as every imp', () => {
  const guard = createImpGuard({ all: true });

  expect(guard.summary).toBe('every imp');
});

test('#createImpGuard asks for a name when only an allow-list guards the server', () => {
  const guard = createImpGuard({ allow: ['shared', 'box'] });

  expect(() => guard.pickNewName()).toThrowWithMessage(
    GuardError,
    'give a name: the imps shared, box',
  );
});

test('#createPatternGuard picks a name under a single prefix pattern', () => {
  const guard = createPatternGuard(['agent-*']);

  expect(guard.pickNewName()).toMatch(/^agent-[a-z0-9]{8}$/);
});

test('#createPatternGuard leaves every imp to impd to refuse', () => {
  const guard = createPatternGuard(['agent-*']);

  expect(guard.isAllowed('anything')).toBeTrue();
});

test('#createPatternGuard summarises the patterns', () => {
  const guard = createPatternGuard(['agent-*', 'box']);

  expect(guard.summary).toBe('imps matching agent-*, box');
});

test.each([
  [['a-*', 'b-*'], 'a-*, b-*'],
  [['box'], 'box'],
  [['a*b*'], 'a*b*'],
  [['aaaaaaaaaaaaaaaaaaaaaaaa*'], 'aaaaaaaaaaaaaaaaaaaaaaaa*'],
])('#createPatternGuard asks for a name under the patterns %p', (patterns, listed) => {
  const guard = createPatternGuard(patterns);

  expect(() => guard.pickNewName()).toThrowWithMessage(
    GuardError,
    `this token may touch only imps matching ${listed}, so give the new imp a name that matches`,
  );
});

test('#createPatternGuard leaves the new name to impd for a token with no patterns', () => {
  const guard = createPatternGuard(null);

  expect(guard.pickNewName()).toBeNull();
});
