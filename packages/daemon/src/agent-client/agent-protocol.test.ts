import { expect, test } from 'bun:test';
import {
  KILL_GRACE_MAX_MS,
  SERVICE_LOG_MAX_LINES,
  SERVICE_NAME_PATTERN,
  SESSION_NAME_PATTERN,
  TAR_TOTAL_RECORD,
} from '@imp/api';
import { listAgentFixtures } from '@imp/test-utils/list-agent-fixtures';
import { readAgentFixture } from '@imp/test-utils/read-agent-fixture';
import { collectJsonKeyPaths } from '../test-utils/collect-json-key-paths';
import { collectSchemaKeyPaths } from '../test-utils/collect-schema-key-paths';
import {
  AGENT_ERROR_CODES,
  ActivityResponseSchema,
  AgentErrorResponseSchema,
  AgentExitSchema,
  AgentRequestSchema,
  AgentRequestSchemas,
  AgentResizeSchema,
  AgentSessionObjectSchema,
  AgentSignalSchema,
  ConnectionSchema,
  DetachedSchema,
  InvalidResumeDataSchema,
  ListenResponseSchema,
  LogCursorSchema,
  NoSessionDataSchema,
  OkResponseSchema,
  PingResponseSchema,
  ServicesListSchema,
  StartedSchema,
} from './agent-protocol';
import { FRAME_TYPES, MAX_PAYLOAD } from './frame-codec';

// testdata/guest is what the agent sends and testdata/host what impd sends
// (docs/architecture/guest/protocol.md#contract-tests)

test.each([
  ['ping', PingResponseSchema],
  ['ping-inner-up', PingResponseSchema],
  ['ok', OkResponseSchema],
  ['error', AgentErrorResponseSchema],
  ['error-no-session', AgentErrorResponseSchema],
  ['error-invalid-resume', AgentErrorResponseSchema],
  ['listening-socket', ListenResponseSchema],
  ['listening-port', ListenResponseSchema],
  ['connection', ConnectionSchema],
  ['activity', ActivityResponseSchema],
  ['started', StartedSchema],
  ['started-resume-gap', StartedSchema],
  ['started-resume-exact', StartedSchema],
  ['exit', AgentExitSchema],
  ['detached', DetachedSchema],
  ['services-list', ServicesListSchema],
  ['cursor', LogCursorSchema],
] as const)('it parses the agent’s %s message with no field left over', (name, schema) => {
  const fixture = readAgentFixture(`guest/${name}.json`);

  expect(schema.parse(fixture)).toStrictEqual(fixture);
});

test('it reads every fixture the agent writes', () => {
  expect(listAgentFixtures('guest')).toStrictEqual([
    'activity',
    'connection',
    'cursor',
    'detached',
    'error',
    'error-codes',
    'error-invalid-resume',
    'error-no-session',
    'exit',
    'frame-types',
    'limits',
    'listening-port',
    'listening-socket',
    'ok',
    'ping',
    'ping-inner-up',
    'services-list',
    'started',
    'started-resume-exact',
    'started-resume-gap',
    'tar',
  ]);
});

test.each([
  ['ping', PingResponseSchema, ['ping', 'ping-inner-up']],
  ['ok', OkResponseSchema, ['ok']],
  ['an error', AgentErrorResponseSchema, ['error', 'error-no-session', 'error-invalid-resume']],
  ['listening', ListenResponseSchema, ['listening-socket', 'listening-port']],
  ['connection', ConnectionSchema, ['connection']],
  ['activity', ActivityResponseSchema, ['activity']],
  ['started', StartedSchema, ['started', 'started-resume-gap', 'started-resume-exact']],
  ['exit', AgentExitSchema, ['exit']],
  ['detached', DetachedSchema, ['detached']],
  ['the services list', ServicesListSchema, ['services-list']],
  ['a log cursor', LogCursorSchema, ['cursor']],
] as const)(
  'it finds each field it reads from %s in a message the agent sends',
  (_label, schema, names) => {
    const sent = names.flatMap((name) =>
      collectJsonKeyPaths(readAgentFixture(`guest/${name}.json`)),
    );

    expect(sent).toIncludeAllMembers(collectSchemaKeyPaths(schema));
  },
);

test('it finds each field it reads from a session in the activity the agent sends', () => {
  const sent = collectJsonKeyPaths(readAgentFixture('guest/activity.json'));

  expect(sent).toIncludeAllMembers(
    collectSchemaKeyPaths(AgentSessionObjectSchema).map((path) => `sessions[].${path}`),
  );
});

test('it parses the data of NO_SESSION whole, with every field it reads set', () => {
  const fixture = AgentErrorResponseSchema.parse(readAgentFixture('guest/error-no-session.json'));

  expect(NoSessionDataSchema.parse(fixture.error.data)).toStrictEqual(fixture.error.data);

  expect(collectJsonKeyPaths(fixture.error.data)).toIncludeAllMembers(
    collectSchemaKeyPaths(NoSessionDataSchema),
  );
});

test('it parses the data of INVALID_RESUME whole, with every field it reads set', () => {
  const fixture = AgentErrorResponseSchema.parse(
    readAgentFixture('guest/error-invalid-resume.json'),
  );

  expect(InvalidResumeDataSchema.parse(fixture.error.data)).toStrictEqual(fixture.error.data);

  expect(collectJsonKeyPaths(fixture.error.data)).toIncludeAllMembers(
    collectSchemaKeyPaths(InvalidResumeDataSchema),
  );
});

test('it numbers the frame types as the agent does', () => {
  expect(readAgentFixture('guest/frame-types.json')).toStrictEqual({
    REQUEST: FRAME_TYPES.request,
    RESPONSE: FRAME_TYPES.response,
    STDIN: FRAME_TYPES.stdin,
    STDIN_EOF: FRAME_TYPES.stdinEof,
    RESIZE: FRAME_TYPES.resize,
    SIGNAL: FRAME_TYPES.signal,
    STARTED: FRAME_TYPES.started,
    STDOUT: FRAME_TYPES.stdout,
    STDERR: FRAME_TYPES.stderr,
    EXIT: FRAME_TYPES.exit,
    DETACHED: FRAME_TYPES.detached,
    STDOUT_EOF: FRAME_TYPES.stdoutEof,
    CONNECTION: FRAME_TYPES.connection,
    CURSOR: FRAME_TYPES.cursor,
  });
});

test('it knows every error code the agent sends', () => {
  expect(readAgentFixture('guest/error-codes.json')).toStrictEqual([...AGENT_ERROR_CODES]);
});

test('it holds the limits the agent holds', () => {
  expect(readAgentFixture('guest/limits.json')).toStrictEqual({
    max_payload: MAX_PAYLOAD,
    max_kill_grace_ms: KILL_GRACE_MAX_MS,
    max_log_lines: SERVICE_LOG_MAX_LINES,
    session_name_pattern: SESSION_NAME_PATTERN.source,
    service_name_pattern: SERVICE_NAME_PATTERN.source,
  });
});

test('it reads the tar tool’s total from the record the agent writes', () => {
  expect(readAgentFixture('guest/tar.json')).toStrictEqual({ total_record: TAR_TOTAL_RECORD });
});

test.each(listAgentFixtures('host/requests'))(
  'it sends the agent a %s request it parses with no field left over',
  (op) => {
    const fixture = readAgentFixture(`host/requests/${op}.json`);

    expect(AgentRequestSchema.parse(fixture)).toStrictEqual(fixture);
  },
);

test('it keeps a host fixture for every op it sends', () => {
  const ops: string[] = [];

  for (const schema of Object.values(AgentRequestSchemas)) {
    ops.push(...schema.shape.op.values);
  }

  expect(listAgentFixtures('host/requests')).toStrictEqual(ops.toSorted());
});

test.each(Object.entries(AgentRequestSchemas))(
  'it sets each field of its %s requests in a fixture the agent decodes',
  (_key, schema) => {
    const sent = [...schema.shape.op.values].flatMap((op) =>
      collectJsonKeyPaths(readAgentFixture(`host/requests/${op}.json`)),
    );

    expect(sent).toIncludeAllMembers(collectSchemaKeyPaths(schema));
  },
);

test.each([
  ['resize', AgentResizeSchema],
  ['signal', AgentSignalSchema],
] as const)('it sends the agent a %s frame it parses with every field set', (name, schema) => {
  const fixture = readAgentFixture(`host/${name}.json`);

  expect(schema.parse(fixture)).toStrictEqual(fixture);
  expect(collectJsonKeyPaths(fixture)).toStrictEqual(collectSchemaKeyPaths(schema));
});
