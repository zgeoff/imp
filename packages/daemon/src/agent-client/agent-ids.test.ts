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

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_format' });
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

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_format' });
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

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_format' });
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
  ['generation is a slash', { generation: '/' }],
  ['generation is a backslash', { generation: '\\' }],
  ['generation is a path with a slash', { generation: 'a/b' }],
  ['generation is a path with a backslash', { generation: String.raw`a\b` }],
  ['generation is the parent directory', { generation: '..' }],
  ['generation is the current directory', { generation: '.' }],
  ['generation is a relative traversal', { generation: '../../../evil' }],
  ['generation is a backslash traversal', { generation: String.raw`..\..\evil` }],
  ['generation is an absolute path', { generation: '/etc/passwd' }],
  ['generation is a drive path', { generation: String.raw`C:\evil` }],
  ['generation is a NUL', { generation: '\0' }],
  ['generation is a NUL inside a name', { generation: 'a\0b' }],
  ['generation is a value of 4096 characters', { generation: 'x'.repeat(4096) }],
  ['generation is an empty value', { generation: '' }],
  ['generation is 31 hex characters and a slash', { generation: `${'a'.repeat(31)}/` }],
  ['generation is 31 hex characters and a backslash', { generation: `${'a'.repeat(31)}\\` }],
  [
    'generation is a traversal between hex characters',
    { generation: `${'a'.repeat(16)}/../${'a'.repeat(13)}` },
  ],
  ['generation is a slash and 31 hex characters', { generation: `/${'a'.repeat(31)}` }],
  ['generation is 31 hex characters and a NUL', { generation: `${'a'.repeat(31)}\0` }],
  ['generation is 31 hex characters', { generation: 'a'.repeat(31) }],
  ['generation is 33 hex characters', { generation: 'a'.repeat(33) }],
  ['generation is 32 uppercase hex characters', { generation: 'A'.repeat(32) }],
  ['generation is 32 letters that are not hex', { generation: 'g'.repeat(32) }],
  ['generation is a UUID', { generation: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' }],
  ['boot id is a slash', { bootId: '/' }],
  ['boot id is a backslash', { bootId: '\\' }],
  ['boot id is a path with a slash', { bootId: 'a/b' }],
  ['boot id is a path with a backslash', { bootId: String.raw`a\b` }],
  ['boot id is the parent directory', { bootId: '..' }],
  ['boot id is the current directory', { bootId: '.' }],
  ['boot id is a relative traversal', { bootId: '../../../evil' }],
  ['boot id is a backslash traversal', { bootId: String.raw`..\..\evil` }],
  ['boot id is an absolute path', { bootId: '/etc/passwd' }],
  ['boot id is a drive path', { bootId: String.raw`C:\evil` }],
  ['boot id is a NUL', { bootId: '\0' }],
  ['boot id is a NUL inside a name', { bootId: 'a\0b' }],
  ['boot id is a value of 4096 characters', { bootId: 'x'.repeat(4096) }],
  ['boot id is a UUID that ends in a slash', { bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1/' }],
  [
    'boot id is a UUID that ends in a backslash',
    { bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1\\' },
  ],
  ['boot id is a traversal into a UUID', { bootId: '../c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' }],
  ['boot id is a UUID and a NUL', { bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11\0' }],
  ['boot id is a UUID one character short', { bootId: 'f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' }],
  ['boot id is a UUID one character long', { bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d110' }],
  ['boot id is an uppercase UUID', { bootId: '4F3C0F86-8F8B-4C45-A3B4-8E1C1E9B0D11' }],
  [
    'boot id is a UUID with a letter that is not hex',
    { bootId: '4g3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' },
  ],
  ['boot id is a UUID without its dashes', { bootId: '4f3c0f868f8b4c45a3b48e1c1e9b0d11' }],
  ['session name is a slash', { session: '/' }],
  ['session name is a backslash', { session: '\\' }],
  ['session name is a path with a slash', { session: 'a/b' }],
  ['session name is a path with a backslash', { session: String.raw`a\b` }],
  ['session name is the parent directory', { session: '..' }],
  ['session name is the current directory', { session: '.' }],
  ['session name is a relative traversal', { session: '../../../evil' }],
  ['session name is a backslash traversal', { session: String.raw`..\..\evil` }],
  ['session name is an absolute path', { session: '/etc/passwd' }],
  ['session name is a drive path', { session: String.raw`C:\evil` }],
  ['session name is a NUL', { session: '\0' }],
  ['session name is a NUL inside a name', { session: 'a\0b' }],
  ['session name is a value of 4096 characters', { session: 'x'.repeat(4096) }],
  ['session name is an empty name', { session: '' }],
  ['session name is a name and a traversal', { session: 'main/..' }],
  ['session name is a name with a backslash', { session: String.raw`main\x` }],
  ['session name is a name and a NUL', { session: 'main\0' }],
  ['session name is a name of 33 characters', { session: 'a'.repeat(33) }],
  ['session name is an uppercase name', { session: 'Main' }],
  ['session name is a name that starts with a dash', { session: '-main' }],
  ['session name is a name with a dot', { session: 'main.log' }],
])('#isAgentLogIdentity refuses an identity whose %s', (_label, forged) => {
  expect(
    isAgentLogIdentity({
      generation: '0123456789abcdef0123456789abcdef',
      session: 'main',
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      ...forged,
    }),
  ).toBe(false);
});
