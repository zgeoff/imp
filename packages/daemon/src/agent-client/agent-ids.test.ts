import { expect, test } from 'bun:test';
import {
  AgentBootIdSchema,
  AgentGenerationSchema,
  AgentSessionNameSchema,
  isAgentLogIdentity,
} from './agent-ids';

test('#AgentGenerationSchema accepts 32 lowercase hex characters', () => {
  const result = AgentGenerationSchema.safeParse('0123456789abcdef0123456789abcdef');

  expect(result.data).toBe('0123456789abcdef0123456789abcdef');
});

// a hostile agent can send anything; each must fail before impd touches the disk
test.each([
  ['a slash', '/'],
  ['a backslash', '\\'],
  ['a path with a slash', 'a/b'],
  ['a path with a backslash', String.raw`a\b`],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative traversal', '../../../evil'],
  ['a backslash traversal', String.raw`..\..\evil`],
  ['an absolute path', '/etc/passwd'],
  ['a drive path', String.raw`C:\evil`],
  ['a NUL', '\0'],
  ['a NUL inside a name', 'a\0b'],
  ['a value of 4096 characters', 'x'.repeat(4096)],
  ['an empty value', ''],
  ['31 hex characters and a slash', `${'a'.repeat(31)}/`],
  ['31 hex characters and a backslash', `${'a'.repeat(31)}\\`],
  ['a traversal between hex characters', `${'a'.repeat(16)}/../${'a'.repeat(13)}`],
  ['a slash and 31 hex characters', `/${'a'.repeat(31)}`],
  ['31 hex characters and a NUL', `${'a'.repeat(31)}\0`],
  ['31 hex characters', 'a'.repeat(31)],
  ['33 hex characters', 'a'.repeat(33)],
  ['32 uppercase hex characters', 'A'.repeat(32)],
  ['32 letters that are not hex', 'g'.repeat(32)],
  ['a UUID', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
])('#AgentGenerationSchema rejects %s', (_label, value) => {
  const result = AgentGenerationSchema.safeParse(value);

  expect(result.error?.issues).toPartiallyContain({ path: [] });
});

test('#AgentBootIdSchema accepts a lowercase UUID', () => {
  const result = AgentBootIdSchema.safeParse('4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11');

  expect(result.data).toBe('4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11');
});

test('#AgentBootIdSchema accepts the empty boot id of an agent without procfs', () => {
  const result = AgentBootIdSchema.safeParse('');

  expect(result.data).toBe('');
});

test.each([
  ['a slash', '/'],
  ['a backslash', '\\'],
  ['a path with a slash', 'a/b'],
  ['a path with a backslash', String.raw`a\b`],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative traversal', '../../../evil'],
  ['a backslash traversal', String.raw`..\..\evil`],
  ['an absolute path', '/etc/passwd'],
  ['a drive path', String.raw`C:\evil`],
  ['a NUL', '\0'],
  ['a NUL inside a name', 'a\0b'],
  ['a value of 4096 characters', 'x'.repeat(4096)],
  ['a UUID that ends in a slash', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1/'],
  ['a UUID that ends in a backslash', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1\\'],
  ['a traversal into a UUID', '../c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a UUID and a NUL', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11\0'],
  ['a UUID one character short', 'f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a UUID one character long', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d110'],
  ['an uppercase UUID', '4F3C0F86-8F8B-4C45-A3B4-8E1C1E9B0D11'],
  ['a UUID with a letter that is not hex', '4g3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a UUID without its dashes', '4f3c0f868f8b4c45a3b48e1c1e9b0d11'],
])('#AgentBootIdSchema rejects %s', (_label, value) => {
  const result = AgentBootIdSchema.safeParse(value);

  expect(result.error?.issues).toPartiallyContain({ path: [] });
});

test('#AgentSessionNameSchema accepts a session name the agent makes', () => {
  const result = AgentSessionNameSchema.safeParse('main');

  expect(result.data).toBe('main');
});

test.each([
  ['a slash', '/'],
  ['a backslash', '\\'],
  ['a path with a slash', 'a/b'],
  ['a path with a backslash', String.raw`a\b`],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative traversal', '../../../evil'],
  ['a backslash traversal', String.raw`..\..\evil`],
  ['an absolute path', '/etc/passwd'],
  ['a drive path', String.raw`C:\evil`],
  ['a NUL', '\0'],
  ['a NUL inside a name', 'a\0b'],
  ['a value of 4096 characters', 'x'.repeat(4096)],
  ['an empty name', ''],
  ['a name and a traversal', 'main/..'],
  ['a name with a backslash', String.raw`main\x`],
  ['a name and a NUL', 'main\0'],
  ['a name of 33 characters', 'a'.repeat(33)],
  ['an uppercase name', 'Main'],
  ['a name that starts with a dash', '-main'],
  ['a name with a dot', 'main.log'],
])('#AgentSessionNameSchema rejects %s', (_label, value) => {
  const result = AgentSessionNameSchema.safeParse(value);

  expect(result.error?.issues).toPartiallyContain({ path: [] });
});

test('#isAgentLogIdentity accepts the names a real agent sends', () => {
  expect(
    isAgentLogIdentity({
      generation: '0123456789abcdef0123456789abcdef',
      session: 'main',
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    }),
  ).toBe(true);
});

test.each([
  [
    'a generation with a traversal',
    '../../../evil',
    'main',
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  [
    'a session name with a slash',
    '0123456789abcdef0123456789abcdef',
    'a/b',
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  [
    'a boot id with a NUL',
    '0123456789abcdef0123456789abcdef',
    'main',
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11\0',
  ],
])('#isAgentLogIdentity refuses %s', (_label, generation, session, bootId) => {
  expect(isAgentLogIdentity({ generation, session, bootId })).toBe(false);
});
