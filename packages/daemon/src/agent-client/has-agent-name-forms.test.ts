import { expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { ActivitySchema, SessionInfoSchema, StartedSchema } from './agent-protocol';
import { hasAgentNameForms } from './has-agent-name-forms';

test('it accepts a session whose names have the agent’s form', () => {
  expect(
    hasAgentNameForms(
      create(SessionInfoSchema, {
        name: 'build',
        executionGeneration: '0123456789abcdef0123456789abcdef',
        bootId: '6f1c2a9e-3b7d-4e58-9a10-2c4b8d7e5f31',
      }),
    ),
  ).toBeTrue();
});

test('it accepts a session from an agent before output offsets, with no generation or boot', () => {
  expect(hasAgentNameForms(create(SessionInfoSchema, { name: 'build' }))).toBeTrue();
});

test.each([
  ['a session name', { name: '../etc', executionGeneration: '0123456789abcdef0123456789abcdef' }],
  ['a generation', { name: 'build', executionGeneration: '../../x' }],
  ['a boot ID', { name: 'build', bootId: 'NOT-A-UUID' }],
])('it refuses %s the agent never makes', (_label, session) => {
  expect(hasAgentNameForms(create(SessionInfoSchema, session))).toBeFalse();
});

test('it checks the names in a nested message', () => {
  expect(
    hasAgentNameForms(
      create(StartedSchema, {
        pid: 9,
        session: 'build',
        output: {
          bootId: '6f1c2a9e-3b7d-4e58-9a10-2c4b8d7e5f31',
          executionGeneration: '0123456789abcdef0123456789abcdef',
          previous: { executionGeneration: 'not-hex' },
        },
      }),
    ),
  ).toBeFalse();
});

test('it checks the names of each message in a list', () => {
  expect(
    hasAgentNameForms(create(ActivitySchema, { sessions: [{ name: 'ok' }, { name: 'Bad Name' }] })),
  ).toBeFalse();
});

test('it refuses an empty session name in STARTED', () => {
  expect(hasAgentNameForms(create(StartedSchema, { pid: 9, session: '' }))).toBeFalse();
});
