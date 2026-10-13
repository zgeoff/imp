import { expect, test } from 'bun:test';
import { ProtocolSchemaSchema, buildProtocolSchema } from './build-protocol-schema';

test('it renders a procedure under its RPC path as JSON Schema', () => {
  expect(buildProtocolSchema().procedures['imps.destroy']).toMatchInlineSnapshot(`
    {
      "input": {
        "properties": {
          "name": {
            "pattern": "^[a-z][a-z0-9-]{0,30}$",
            "type": "string",
          },
        },
        "required": [
          "name",
        ],
        "type": "object",
      },
      "output": {
        "additionalProperties": false,
        "properties": {},
        "type": "object",
      },
      "stream": false,
    }
  `);
});

test('it gives an event-iterator procedure the schema of each event', () => {
  const procedure = buildProtocolSchema().procedures['images.addStream'];

  expect(procedure?.stream).toBe(true);
  expect(procedure?.output['oneOf']).toBeArrayOfSize(2);
});

test('it marks a procedure with a single answer as no stream', () => {
  expect(buildProtocolSchema().procedures['imps.get']?.stream).toBe(false);
});

test('it renders a date in an output as a date-time string', () => {
  const output = buildProtocolSchema().procedures['imps.get']?.output;

  expect(output?.['properties']).toMatchObject({
    createdAt: { type: 'string', format: 'date-time' },
  });
});

test('it tags a type that JSON Schema cannot express', () => {
  const output = buildProtocolSchema().procedures['sessions.readLog']?.output;

  expect(output?.['properties']).toMatchObject({ data: { 'x-unrepresentable': 'custom' } });
});

test('it reads each stream message in the direction it travels', () => {
  const messages = buildProtocolSchema().messages;

  expect(
    Object.fromEntries(
      Object.entries(messages).map(([name, message]) => [name, message.direction]),
    ),
  ).toStrictEqual({
    'exec.client': 'toServer',
    'exec.server': 'toClient',
    'tunnel.client': 'toServer',
    'tunnel.server': 'toClient',
    'imageBuild.query': 'toServer',
    'imageBuild.event': 'toClient',
    'imageBuild.result': 'toClient',
    'imageBuild.error': 'toClient',
  });
});

test('it keeps a custom error status and leaves a common code to oRPC', () => {
  const errors = buildProtocolSchema().errors;

  expect(errors['LEASED']?.status).toBe(409);
  expect(errors['NOT_FOUND']?.status).toBeNull();
});

test('it lists the wire constants', () => {
  expect(buildProtocolSchema().constants).toMatchObject({
    EXEC_PATH: '/exec',
    TUNNEL_PATH: '/tunnel',
    IMAGE_BUILD_PATH: '/images/build',
  });
});

test('it builds a schema that its own parser accepts', () => {
  const schema = buildProtocolSchema();

  expect(ProtocolSchemaSchema.parse(schema)).toStrictEqual(schema);
});

test('it parses a protocol schema with no entries', () => {
  const payload = { procedures: {}, messages: {}, errors: {}, constants: {} };

  expect(ProtocolSchemaSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('it rejects a message with an unknown direction', () => {
  const result = ProtocolSchemaSchema.safeParse({
    procedures: {},
    messages: { 'exec.client': { direction: 'sideways', schema: {} } },
    errors: {},
    constants: {},
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['messages', 'exec.client', 'direction'],
  });
});
