import { expect, test } from 'bun:test';
import { GuardError, createImpGuard, createPatternGuard } from './imp-guard';

test('a server needs a guard, and --all excludes the others', () => {
  expect(() => createImpGuard({})).toThrow(
    new GuardError('choose the imps this server may touch: --prefix, --allow or --all'),
  );

  expect(() => createImpGuard({ all: true, prefix: 'a-' })).toThrow(GuardError);
  expect(() => createImpGuard({ all: true, allow: ['a'] })).toThrow(GuardError);
});

test('a prefix must start a valid name and leave room for the suffix', () => {
  expect(() => createImpGuard({ prefix: 'Agent-' })).toThrow(GuardError);
  expect(() => createImpGuard({ prefix: '-x' })).toThrow(GuardError);
  expect(() => createImpGuard({ prefix: 'a'.repeat(24) })).toThrow(GuardError);
  expect(createImpGuard({ prefix: 'a'.repeat(23) }).pickNewName()).toHaveLength(31);
});

test('an allow-list takes only valid names', () => {
  expect(() => createImpGuard({ allow: ['ok', 'Not Ok'] })).toThrow(
    new GuardError('--allow: Not Ok is not a valid imp name'),
  );
});

test('a prefix and an allow-list together allow either', () => {
  const guard = createImpGuard({ prefix: 'agent-', allow: ['shared'] });

  expect(guard.isAllowed('agent-x')).toBe(true);
  expect(guard.isAllowed('shared')).toBe(true);
  expect(guard.isAllowed('shared2')).toBe(false);
  expect(guard.isAllowed('agent')).toBe(false);
  expect(guard.summary).toBe('imps named agent-* and the imps shared');

  expect(() => {
    guard.require('prod');
  }).toThrow(
    new GuardError(
      "imp prod is outside this server's guard: imps named agent-* and the imps shared",
    ),
  );
});

test('--all allows every imp and lets impd pick new names', () => {
  const guard = createImpGuard({ all: true });

  expect(guard.isAllowed('anything')).toBe(true);
  expect(guard.pickNewName()).toBeNull();
  expect(guard.summary).toBe('every imp');
});

test('a token with one prefix pattern gets names picked under it', () => {
  const guard = createPatternGuard(['agent-*']);

  expect(guard.pickNewName()).toMatch(/^agent-[a-z0-9]{8}$/);
  expect(guard.isAllowed('anything')).toBe(true);
  expect(guard.summary).toBe('imps matching agent-*');
});

test('any other set of patterns needs a name, and no patterns lets impd pick', () => {
  for (const patterns of [['a-*', 'b-*'], ['box'], ['a*b*'], [`${'a'.repeat(24)}*`]]) {
    const guard = createPatternGuard(patterns);

    expect(() => guard.pickNewName()).toThrow(
      new GuardError(
        `this token may touch only imps matching ${patterns.join(', ')}, so give the new imp a name that matches`,
      ),
    );
  }

  expect(createPatternGuard(null).pickNewName()).toBeNull();
});
