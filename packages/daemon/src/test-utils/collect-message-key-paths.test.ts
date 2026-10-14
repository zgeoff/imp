import { expect, test } from 'bun:test';
import {
  ActivitySchema,
  ErrorResponseSchema,
  ResumeFromSchema,
} from '../agent-client/agent-protocol';
import { collectMessageKeyPaths } from './collect-message-key-paths';

test('it lists the fields of a message under the schema’s names', () => {
  expect(collectMessageKeyPaths(ResumeFromSchema)).toStrictEqual([
    'execution_generation',
    'offset',
  ]);
});

test('it lists the fields of a nested message under its field', () => {
  expect(collectMessageKeyPaths(ErrorResponseSchema)).toStrictEqual([
    'error',
    'error.code',
    'error.data',
    'error.data.boot_id',
    'error.data.buffer_start',
    'error.data.end',
    'error.data.previous',
    'error.data.previous.end',
    'error.data.previous.execution_generation',
    'error.data.previous.exit',
    'error.data.previous.exit.code',
    'error.data.previous.exit.signal',
    'error.message',
  ]);
});

test('it lists a list’s items, and the fields of the messages in it', () => {
  expect(collectMessageKeyPaths(ActivitySchema)).toStrictEqual([
    'exec_sessions',
    'load1',
    'sessions',
    'sessions[]',
    'sessions[].argv',
    'sessions[].argv[]',
    'sessions[].attached',
    'sessions[].boot_id',
    'sessions[].cols',
    'sessions[].end',
    'sessions[].execution_generation',
    'sessions[].exit',
    'sessions[].exit.code',
    'sessions[].exit.signal',
    'sessions[].log',
    'sessions[].name',
    'sessions[].pid',
    'sessions[].rows',
    'sessions[].started_unix_ms',
    'sessions[].state',
    'tcp_established',
  ]);
});
