import { expect, test } from 'bun:test';
import { collectBreakingChanges, collectJsonOutputChanges } from './collect-breaking-changes';

test('#collectJsonOutputChanges reports a field that a command’s output drops', () => {
  const base = {
    outputs: {
      info: {
        procedure: 'system.info',
        schema: {
          type: 'object',
          properties: { version: { type: 'string' }, ramBudgetMib: { type: 'integer' } },
          required: ['version', 'ramBudgetMib'],
          additionalProperties: false,
        },
      },
    },
  };

  const head = {
    outputs: {
      info: {
        procedure: 'system.info',
        schema: {
          type: 'object',
          properties: { ramBudgetMib: { type: 'integer' } },
          required: ['ramBudgetMib'],
          additionalProperties: false,
        },
      },
    },
  };

  expect(collectJsonOutputChanges(base, head)).toStrictEqual([
    'impz info --json .version: may now be missing',
  ]);
});

test('#collectJsonOutputChanges reports a field that a command’s output renames', () => {
  const base = {
    outputs: {
      info: {
        procedure: 'system.info',
        schema: {
          type: 'object',
          properties: { ramBudgetMib: { type: 'integer' } },
          required: ['ramBudgetMib'],
          additionalProperties: false,
        },
      },
    },
  };

  const head = {
    outputs: {
      info: {
        procedure: 'system.info',
        schema: {
          type: 'object',
          properties: { ramLimitMib: { type: 'integer' } },
          required: ['ramLimitMib'],
          additionalProperties: false,
        },
      },
    },
  };

  expect(collectJsonOutputChanges(base, head)).toStrictEqual([
    'impz info --json .ramBudgetMib: may now be missing',
  ]);
});

test('#collectJsonOutputChanges reports an optional field that a command’s output drops', () => {
  const base = {
    outputs: {
      info: {
        procedure: 'system.info',
        schema: {
          type: 'object',
          properties: { version: { type: 'string' }, ramSleepingMib: { type: 'integer' } },
          required: ['version'],
          additionalProperties: false,
        },
      },
    },
  };

  const head = {
    outputs: {
      info: {
        procedure: 'system.info',
        schema: {
          type: 'object',
          properties: { version: { type: 'string' } },
          required: ['version'],
          additionalProperties: false,
        },
      },
    },
  };

  expect(collectJsonOutputChanges(base, head)).toStrictEqual([
    'impz info --json .ramSleepingMib: removed',
  ]);
});

test('#collectJsonOutputChanges reports an optional field that a command’s output renames', () => {
  const base = {
    outputs: {
      info: {
        procedure: 'system.info',
        schema: {
          type: 'object',
          properties: {
            storage: {
              type: 'object',
              properties: { usedBytes: { type: 'integer' }, isLow: { type: 'boolean' } },
              required: ['usedBytes'],
              additionalProperties: false,
            },
          },
          required: ['storage'],
          additionalProperties: false,
        },
      },
    },
  };

  const head = {
    outputs: {
      info: {
        procedure: 'system.info',
        schema: {
          type: 'object',
          properties: {
            storage: {
              type: 'object',
              properties: { usedBytes: { type: 'integer' }, isFull: { type: 'boolean' } },
              required: ['usedBytes'],
              additionalProperties: false,
            },
          },
          required: ['storage'],
          additionalProperties: false,
        },
      },
    },
  };

  expect(collectJsonOutputChanges(base, head)).toStrictEqual([
    'impz info --json .storage.isLow: removed',
  ]);
});

test('#collectBreakingChanges passes an optional output field that a procedure drops', () => {
  const base = {
    procedures: {
      'system.info': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { version: { type: 'string' }, ramSleepingMib: { type: 'integer' } },
          required: ['version'],
          additionalProperties: false,
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'system.info': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { version: { type: 'string' } },
          required: ['version'],
          additionalProperties: false,
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});

test('#collectJsonOutputChanges passes a field that a command’s output adds', () => {
  const base = {
    outputs: {
      'db copy': {
        procedure: 'system.copyDatabase',
        schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
  };

  const head = {
    outputs: {
      'db copy': {
        procedure: 'system.copyDatabase',
        schema: {
          type: 'object',
          properties: { path: { type: 'string' }, sizeBytes: { type: 'integer' } },
          required: ['path', 'sizeBytes'],
          additionalProperties: false,
        },
      },
    },
  };

  expect(collectJsonOutputChanges(base, head)).toStrictEqual([]);
});

test('#collectJsonOutputChanges reports a command that head no longer covers', () => {
  const base = {
    outputs: {
      ls: { procedure: 'imps.list', schema: { type: 'array' } },
      info: { procedure: 'system.info', schema: { type: 'object' } },
    },
  };

  const head = {
    outputs: { info: { procedure: 'system.info', schema: { type: 'object' } } },
  };

  expect(collectJsonOutputChanges(base, head)).toStrictEqual(['impz ls --json: removed']);
});

test('#collectBreakingChanges finds nothing between a schema and itself', () => {
  const schema = {
    procedures: {
      'imps.get': {
        input: {
          type: 'object',
          properties: { name: { type: 'string', pattern: '^[a-z]+$' } },
          required: ['name'],
        },
        output: {
          type: 'object',
          properties: { state: { type: 'string', enum: ['running', 'sleeping'] } },
          required: ['state'],
          additionalProperties: false,
        },
        stream: false,
      },
    },
    messages: {
      'exec.client': {
        direction: 'toServer' as const,
        schema: { type: 'object', properties: { type: { type: 'string', const: 'start' } } },
      },
    },
    errors: { NOT_FOUND: { status: null, data: { type: 'object' } } },
    constants: { EXEC_PATH: '/exec' },
  };

  expect(collectBreakingChanges(schema, structuredClone(schema))).toStrictEqual([]);
});

test('#collectBreakingChanges reports a procedure that head removes', () => {
  const base = {
    procedures: {
      'imps.get': { input: { type: 'object' }, output: { type: 'object' }, stream: false },
      'imps.list': { input: { type: 'object' }, output: { type: 'array' }, stream: false },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.list': { input: { type: 'object' }, output: { type: 'array' }, stream: false },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual(['procedure imps.get: removed']);
});

test('#collectBreakingChanges passes a procedure that head adds', () => {
  const base = {
    procedures: {},
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.get': { input: { type: 'object' }, output: { type: 'object' }, stream: false },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});

test('#collectBreakingChanges reports a procedure that turns into an event stream', () => {
  const base = {
    procedures: {
      'imps.events': { input: { type: 'object' }, output: { type: 'object' }, stream: false },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.events': { input: { type: 'object' }, output: { type: 'object' }, stream: true },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.events: single answer → event stream',
  ]);
});

test('#collectBreakingChanges reports an input property that becomes required', () => {
  const base = {
    procedures: {
      'imps.create': {
        input: { type: 'object', properties: { name: { type: 'string' } } },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.create': {
        input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.create input .name: now required',
  ]);
});

test('#collectBreakingChanges passes a new optional input property', () => {
  const base = {
    procedures: {
      'imps.create': {
        input: { type: 'object', properties: { name: { type: 'string' } } },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.create': {
        input: {
          type: 'object',
          properties: { name: { type: 'string' }, vcpus: { type: 'integer', minimum: 1 } },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});

test('#collectBreakingChanges reports an input property that impd no longer names', () => {
  const base = {
    procedures: {
      'imps.create': {
        input: {
          type: 'object',
          properties: { name: { type: 'string' }, vcpus: { type: 'integer' } },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.create': {
        input: { type: 'object', properties: { name: { type: 'string' } } },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.create input .vcpus: removed',
  ]);
});

test.each([
  [
    'a lower maximum',
    { maximum: 16 },
    ['procedure imps.create input .vcpus: upper bound <= 32 → <= 16'],
  ],
  ['a higher maximum', { maximum: 64 }, []],
  [
    'a higher minimum',
    { minimum: 2 },
    ['procedure imps.create input .vcpus: lower bound >= 1 → >= 2'],
  ],
  [
    'an exclusive minimum at the old minimum',
    { minimum: undefined, exclusiveMinimum: 1 },
    ['procedure imps.create input .vcpus: lower bound >= 1 → > 1'],
  ],
  ['an exclusive minimum below the old minimum', { minimum: undefined, exclusiveMinimum: 0 }, []],
])('#collectBreakingChanges judges %s on an input number', (_label, bounds, expected) => {
  const base = {
    procedures: {
      'imps.create': {
        input: {
          type: 'object',
          properties: { vcpus: { type: 'integer', minimum: 1, maximum: 32 } },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.create': {
        input: {
          type: 'object',
          properties: { vcpus: { type: 'integer', minimum: 1, maximum: 32, ...bounds } },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual(expected);
});

test.each([
  [
    'a lower max length',
    { maxLength: 32 },
    ['procedure secrets.add input .value: max length <= 64 → <= 32'],
  ],
  ['a higher max length', { maxLength: 128 }, []],
  [
    'a min length',
    { minLength: 8 },
    ['procedure secrets.add input .value: min length none → >= 8'],
  ],
  [
    'a pattern',
    { pattern: '^[a-z]+$' },
    ['procedure secrets.add input .value: pattern none → "^[a-z]+$"'],
  ],
  ['a format', { format: 'email' }, ['procedure secrets.add input .value: format none → "email"']],
])('#collectBreakingChanges judges %s on an input string', (_label, constraints, expected) => {
  const base = {
    procedures: {
      'secrets.add': {
        input: { type: 'object', properties: { value: { type: 'string', maxLength: 64 } } },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'secrets.add': {
        input: {
          type: 'object',
          properties: { value: { type: 'string', maxLength: 64, ...constraints } },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual(expected);
});

test('#collectBreakingChanges reports a value that an input enum drops', () => {
  const base = {
    procedures: {
      'imps.create': {
        input: {
          type: 'object',
          properties: { mode: { type: 'string', enum: ['open', 'box', 'none'] } },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.create': {
        input: { type: 'object', properties: { mode: { type: 'string', enum: ['open', 'box'] } } },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.create input .mode: no longer accepts "none"',
  ]);
});

test('#collectBreakingChanges passes a value that an input enum adds', () => {
  const base = {
    procedures: {
      'imps.create': {
        input: { type: 'object', properties: { mode: { type: 'string', enum: ['open', 'box'] } } },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.create': {
        input: {
          type: 'object',
          properties: { mode: { type: 'string', enum: ['open', 'box', 'public'] } },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});

test('#collectBreakingChanges reports an input that turns from a string into an enum', () => {
  const base = {
    procedures: {
      'imps.create': {
        input: { type: 'object', properties: { mode: { type: 'string' } } },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.create': {
        input: { type: 'object', properties: { mode: { type: 'string', enum: ['open', 'box'] } } },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.create input .mode: values any → "open" | "box"',
  ]);
});

test('#collectBreakingChanges reports an output property that may now be missing', () => {
  const base = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { name: { type: 'string' }, image: { type: 'string' } },
          required: ['name', 'image'],
          additionalProperties: false,
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.get output .image: may now be missing',
  ]);
});

test('#collectBreakingChanges passes an output property that head adds', () => {
  const base = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { name: { type: 'string' }, wakeCount: { type: 'integer' } },
          required: ['name', 'wakeCount'],
          additionalProperties: false,
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});

test('#collectBreakingChanges reports an output that may now be null', () => {
  const base = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { sleptAt: { type: 'string', format: 'date-time' } },
          required: ['sleptAt'],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: {
            sleptAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          },
          required: ['sleptAt'],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.get output .sleptAt: type string → null',
    'procedure imps.get output .sleptAt: format "date-time" → none',
  ]);
});

test('#collectBreakingChanges passes a value that an output enum adds', () => {
  const base = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { state: { type: 'string', enum: ['running', 'sleeping'] } },
          required: ['state'],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { state: { type: 'string', enum: ['running', 'sleeping', 'moving'] } },
          required: ['state'],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});

test('#collectBreakingChanges passes a variant that an output union adds', () => {
  const base = {
    procedures: {},
    messages: {
      'imageBuild.event': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'progress' },
                elapsedMs: { type: 'number' },
              },
              required: ['type', 'elapsedMs'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {},
    messages: {
      'imageBuild.event': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'progress' },
                elapsedMs: { type: 'number' },
              },
              required: ['type', 'elapsedMs'],
            },
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'log' }, line: { type: 'string' } },
              required: ['type', 'line'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});

test('#collectBreakingChanges reports a variant of an output union whose field changes type', () => {
  const base = {
    procedures: {},
    messages: {
      'imageBuild.event': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'progress' },
                elapsedMs: { type: 'number' },
              },
              required: ['type', 'elapsedMs'],
            },
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'error' }, code: { type: 'string' } },
              required: ['type', 'code'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {},
    messages: {
      'imageBuild.event': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'progress' },
                elapsedMs: { type: 'string' },
              },
              required: ['type', 'elapsedMs'],
            },
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'error' }, code: { type: 'string' } },
              required: ['type', 'code'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'message imageBuild.event .elapsedMs: type number → string',
  ]);
});

test('#collectBreakingChanges reports a variant that a union impd reads drops', () => {
  const base = {
    procedures: {},
    messages: {
      'exec.client': {
        direction: 'toServer' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'resize' }, cols: { type: 'integer' } },
              required: ['type', 'cols'],
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'stdout_ack' },
                bytes: { type: 'integer' },
              },
              required: ['type', 'bytes'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {},
    messages: {
      'exec.client': {
        direction: 'toServer' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'resize' }, cols: { type: 'integer' } },
              required: ['type', 'cols'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'message exec.client: no longer accepts the variant type "stdout_ack"',
  ]);
});

test('#collectBreakingChanges reports a message that changes direction or goes', () => {
  const base = {
    procedures: {},
    messages: {
      'tunnel.client': { direction: 'toServer' as const, schema: { type: 'object' } },
      'tunnel.server': { direction: 'toClient' as const, schema: { type: 'object' } },
    },
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {},
    messages: { 'tunnel.client': { direction: 'toClient' as const, schema: { type: 'object' } } },
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'message tunnel.client: toServer → toClient',
    'message tunnel.server: removed',
  ]);
});

test('#collectBreakingChanges reports an error code that goes, a changed status and changed data', () => {
  const base = {
    procedures: {},
    messages: {},
    errors: {
      NOT_FOUND: {
        status: null,
        data: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
      },
      LEASED: { status: 409, data: { type: 'object' } },
      MOVING: { status: 409, data: { type: 'object' } },
    },
    constants: {},
  };

  const head = {
    procedures: {},
    messages: {},
    errors: {
      NOT_FOUND: {
        status: null,
        data: { type: 'object', properties: { kind: { type: 'string' } } },
      },
      LEASED: { status: 423, data: { type: 'object' } },
    },
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'error NOT_FOUND data .kind: may now be missing',
    'error LEASED: status 409 → 423',
    'error MOVING: removed',
  ]);
});

test('#collectBreakingChanges reports a constant that changes or goes', () => {
  const base = {
    procedures: {},
    messages: {},
    errors: {},
    constants: {
      EXEC_PATH: '/exec',
      EXEC_CHANNELS: { stdin: 0, stdout: 1 },
      TUNNEL_PATH: '/tunnel',
    },
  };

  const head = {
    procedures: {},
    messages: {},
    errors: {},
    constants: { EXEC_PATH: '/exec', EXEC_CHANNELS: { stdin: 0, stdout: 2 }, NEW_PATH: '/new' },
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'constant EXEC_CHANNELS: {"stdin":0,"stdout":1} → {"stdin":0,"stdout":2}',
    'constant TUNNEL_PATH: removed',
  ]);
});

test('#collectBreakingChanges reports a change to a keyword it does not read one by one', () => {
  const base = {
    procedures: {
      'sessions.readLog': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { data: { 'x-unrepresentable': 'custom' } },
          required: ['data'],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'sessions.readLog': {
        input: { type: 'object' },
        output: {
          type: 'object',
          properties: { data: { 'x-unrepresentable': 'transform' } },
          required: ['data'],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure sessions.readLog output .data: x-unrepresentable "custom" → "transform"',
  ]);
});

test('#collectBreakingChanges compares a recursive schema through its $ref', () => {
  const base = {
    procedures: {
      'files.tree': {
        input: {
          $ref: '#/$defs/node',
          $defs: {
            node: {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: 255 },
                children: { type: 'array', items: { $ref: '#/$defs/node' } },
              },
              required: ['name'],
            },
          },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'files.tree': {
        input: {
          $ref: '#/$defs/node',
          $defs: {
            node: {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: 64 },
                children: { type: 'array', items: { $ref: '#/$defs/node' } },
              },
              required: ['name'],
            },
          },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure files.tree input .name: max length <= 255 → <= 64',
  ]);
});

test('#collectBreakingChanges reports a record whose values narrow', () => {
  const base = {
    procedures: {
      'imps.update': {
        input: {
          type: 'object',
          properties: {
            env: { type: 'object', additionalProperties: { type: 'string', maxLength: 4096 } },
          },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.update': {
        input: {
          type: 'object',
          properties: {
            env: { type: 'object', additionalProperties: { type: 'string', maxLength: 1024 } },
          },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.update input .env{}: max length <= 4096 → <= 1024',
  ]);
});

test('#collectBreakingChanges reports a changed field of an output variant whose enum also changes', () => {
  const base = {
    procedures: {},
    messages: {
      'imageBuild.event': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'progress' },
                phase: { type: 'string', enum: ['upload', 'build'] },
                elapsedMs: { type: 'number' },
              },
              required: ['type', 'phase', 'elapsedMs'],
            },
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'error' }, code: { type: 'string' } },
              required: ['type', 'code'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {},
    messages: {
      'imageBuild.event': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'progress' },
                phase: { type: 'string', enum: ['download'] },
                elapsedMs: { type: 'string' },
              },
              required: ['type', 'phase', 'elapsedMs'],
            },
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'error' }, code: { type: 'string' } },
              required: ['type', 'code'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'message imageBuild.event .elapsedMs: type number → string',
  ]);
});

test('#collectBreakingChanges reports a changed field of an output variant when a shared version field moves', () => {
  const base = {
    procedures: {},
    messages: {
      'events.stream': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                v: { type: 'number', const: 1 },
                ev: { type: 'string', const: 'ImpAdded' },
                name: { type: 'string' },
              },
              required: ['v', 'ev', 'name'],
            },
            {
              type: 'object',
              properties: {
                v: { type: 'number', const: 1 },
                ev: { type: 'string', const: 'ImpRemoved' },
              },
              required: ['v', 'ev'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {},
    messages: {
      'events.stream': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                v: { type: 'number', const: 2 },
                ev: { type: 'string', const: 'ImpAdded' },
                name: { type: 'string' },
              },
              required: ['v', 'ev'],
            },
            {
              type: 'object',
              properties: {
                v: { type: 'number', const: 2 },
                ev: { type: 'string', const: 'ImpRemoved' },
              },
              required: ['v', 'ev'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'message events.stream .name: may now be missing',
  ]);
});

test('#collectBreakingChanges reports an output variant that impd no longer sends under its tag', () => {
  const base = {
    procedures: {},
    messages: {
      'exec.server': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'started' } },
              required: ['type'],
            },
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'exit' }, code: { type: 'integer' } },
              required: ['type', 'code'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {},
    messages: {
      'exec.server': {
        direction: 'toClient' as const,
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'started' } },
              required: ['type'],
            },
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'exited' }, code: { type: 'integer' } },
              required: ['type', 'code'],
            },
          ],
        },
      },
    },
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'message exec.server: no longer sends the variant type "exit"',
  ]);
});

test('#collectBreakingChanges finds nothing between an intersection and itself', () => {
  const schema = {
    procedures: {
      'imps.rename': {
        input: {
          allOf: [
            { type: 'string', minLength: 1 },
            { type: 'string', maxLength: 10 },
          ],
        },
        output: {
          allOf: [
            { type: 'string', minLength: 1 },
            { type: 'string', maxLength: 10 },
          ],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(schema, structuredClone(schema))).toStrictEqual([]);
});

test('#collectBreakingChanges reports an input intersection whose one side narrows', () => {
  const base = {
    procedures: {
      'imps.rename': {
        input: {
          allOf: [
            { type: 'string', minLength: 1 },
            { type: 'string', maxLength: 10 },
          ],
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.rename': {
        input: {
          allOf: [
            { type: 'string', minLength: 1 },
            { type: 'string', maxLength: 5 },
          ],
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.rename input: max length <= 10 → <= 5',
  ]);
});

test('#collectBreakingChanges reports a property that both sides of an output intersection name and one widens', () => {
  const base = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          allOf: [
            {
              type: 'object',
              properties: { name: { type: 'string', minLength: 1 } },
              required: ['name'],
            },
            {
              type: 'object',
              properties: { name: { type: 'string', maxLength: 10 }, state: { type: 'string' } },
              required: ['state'],
            },
          ],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.get': {
        input: { type: 'object' },
        output: {
          allOf: [
            {
              type: 'object',
              properties: { name: { type: 'string', minLength: 1 } },
              required: ['name'],
            },
            {
              type: 'object',
              properties: { name: { type: 'string', maxLength: 64 }, state: { type: 'string' } },
              required: ['state'],
            },
          ],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([
    'procedure imps.get output .name: max length <= 10 → <= 64',
  ]);
});

test('#collectBreakingChanges finds nothing between an intersection of objects and itself, open in the input and closed in the output', () => {
  const schema = {
    procedures: {
      'imps.label': {
        input: {
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
            { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
          ],
        },
        output: {
          allOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' } },
              required: ['a'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { b: { type: 'string' } },
              required: ['b'],
              additionalProperties: false,
            },
          ],
        },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(schema, structuredClone(schema))).toStrictEqual([]);
});

test('#collectBreakingChanges finds nothing between an intersection of two recursive schemas and itself', () => {
  const schema = {
    procedures: {
      'files.chain': {
        input: {
          allOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }],
          $defs: {
            a: { type: 'object', properties: { next: { $ref: '#/$defs/a' } } },
            b: { type: 'object', properties: { next: { $ref: '#/$defs/b' } } },
          },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(schema, structuredClone(schema))).toStrictEqual([]);
});

test('#collectBreakingChanges finds nothing between an intersection of an object and a record of enums and itself', () => {
  const schema = {
    procedures: {
      'imps.label': {
        input: {
          allOf: [
            { type: 'object', properties: { a: { enum: ['x', 'y'] } } },
            { type: 'object', additionalProperties: { enum: ['y', 'z'] } },
          ],
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(schema, structuredClone(schema))).toStrictEqual([]);
});

test('#collectBreakingChanges passes an input intersection of enums that turns into the values both parts take', () => {
  const base = {
    procedures: {
      'imps.tag': {
        input: { allOf: [{ enum: ['x', 'y'] }, { enum: ['y', 'z'] }] },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.tag': {
        input: { enum: ['y'] },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});

test('#collectBreakingChanges passes an input enum value that the other part of the intersection refused', () => {
  const base = {
    procedures: {
      'imps.tag': {
        input: { allOf: [{ type: 'string', maxLength: 1 }, { enum: ['a', 'long'] }] },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.tag': {
        input: { type: 'string', maxLength: 1 },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});

test('#collectBreakingChanges passes a changed input property that a closed part of the intersection refused', () => {
  const base = {
    procedures: {
      'imps.label': {
        input: {
          allOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' } },
              additionalProperties: false,
            },
            { type: 'object', properties: { b: { type: 'string' } } },
          ],
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  const head = {
    procedures: {
      'imps.label': {
        input: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'integer' } },
        },
        output: { type: 'object' },
        stream: false,
      },
    },
    messages: {},
    errors: {},
    constants: {},
  };

  expect(collectBreakingChanges(base, head)).toStrictEqual([]);
});
