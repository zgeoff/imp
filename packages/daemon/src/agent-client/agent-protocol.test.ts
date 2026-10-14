import { expect, test } from 'bun:test';
import { fromJson, toJson } from '@bufbuild/protobuf';
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
import { collectMessageKeyPaths } from '../test-utils/collect-message-key-paths';
import { AGENT_ERROR_CODES } from './agent-error-codes';
import {
  ActivitySchema,
  ConnectionSchema,
  DetachedSchema,
  ErrorResponseSchema,
  ExitSchema,
  ListeningSchema,
  LogCursorSchema,
  OKSchema,
  PingSchema,
  RequestSchema,
  ResizeSchema,
  ServicesListSchema,
  SignalSchema,
  StartedSchema,
} from './agent-protocol';
import { encodeAgentMessage } from './encode-agent-message';
import { FRAME_TYPES, MAX_PAYLOAD } from './frame-codec';

// testdata/guest is what the agent sends and testdata/host what impd sends
// (docs/architecture/guest/protocol.md#contract-tests)

test.each([
  ['ping', PingSchema],
  ['ping-inner-up', PingSchema],
  ['ok', OKSchema],
  ['error', ErrorResponseSchema],
  ['error-no-session', ErrorResponseSchema],
  ['error-invalid-resume', ErrorResponseSchema],
  ['listening-socket', ListeningSchema],
  ['listening-port', ListeningSchema],
  ['connection', ConnectionSchema],
  ['activity', ActivitySchema],
  ['started', StartedSchema],
  ['started-resume-gap', StartedSchema],
  ['started-resume-exact', StartedSchema],
  ['exit', ExitSchema],
  ['detached', DetachedSchema],
  ['services-list', ServicesListSchema],
  ['cursor', LogCursorSchema],
] as const)('it decodes the agent’s %s message whole and writes it back alike', (name, schema) => {
  const fixture = readAgentFixture(`guest/${name}.json`);
  const decoded = fromJson(schema, fixture);

  expect(
    toJson(schema, decoded, { useProtoFieldName: true, alwaysEmitImplicit: true }),
  ).toStrictEqual(fixture);
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
  ['ping', PingSchema, ['ping', 'ping-inner-up']],
  ['ok', OKSchema, ['ok']],
  ['an error', ErrorResponseSchema, ['error', 'error-no-session', 'error-invalid-resume']],
  ['listening', ListeningSchema, ['listening-socket', 'listening-port']],
  ['connection', ConnectionSchema, ['connection']],
  ['activity', ActivitySchema, ['activity']],
  ['started', StartedSchema, ['started', 'started-resume-gap', 'started-resume-exact']],
  ['exit', ExitSchema, ['exit']],
  ['detached', DetachedSchema, ['detached']],
  ['the services list', ServicesListSchema, ['services-list']],
  ['a log cursor', LogCursorSchema, ['cursor']],
] as const)('it finds each field of %s in a message the agent sends', (_label, schema, names) => {
  const sent = names.flatMap((name) => collectJsonKeyPaths(readAgentFixture(`guest/${name}.json`)));

  expect(sent).toIncludeAllMembers(collectMessageKeyPaths(schema));
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
  'it writes the %s request as the agent’s fixture holds it',
  (op) => {
    const fixture = readAgentFixture(`host/requests/${op}.json`);
    const decoded = fromJson(RequestSchema, fixture);

    expect(decoded.op).toBe(op);
    expect(encodeAgentMessage(RequestSchema, decoded)).toStrictEqual(fixture);
  },
);

// the agent marks where a service came from; impd never says
test('it sets each field of a request in a fixture the agent decodes', () => {
  const sent = listAgentFixtures('host/requests').flatMap((op) =>
    collectJsonKeyPaths(readAgentFixture(`host/requests/${op}.json`)),
  );

  expect(sent).toIncludeAllMembers(
    collectMessageKeyPaths(RequestSchema).filter((path) => path !== 'def.source'),
  );
});

test.each([
  ['resize', ResizeSchema],
  ['signal', SignalSchema],
] as const)(
  'it writes the %s frame as the agent’s fixture holds it, every field set',
  (name, schema) => {
    const fixture = readAgentFixture(`host/${name}.json`);

    expect(encodeAgentMessage(schema, fromJson(schema, fixture))).toStrictEqual(fixture);
    expect(collectJsonKeyPaths(fixture)).toStrictEqual(collectMessageKeyPaths(schema));
  },
);
