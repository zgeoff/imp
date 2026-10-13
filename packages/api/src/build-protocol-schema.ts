import { getEventIteratorSchemaDetails, isContractProcedure } from '@orpc/contract';
import type { AnySchema } from '@orpc/contract';
import * as z from 'zod';
import {
  EXEC_CHANNELS,
  EXEC_CLOSE_RESTARTING,
  EXEC_MAX_STDIN_FRAME_BYTES,
  EXEC_PATH,
  EXEC_STDIN_WINDOW_BYTES,
  EXEC_STDOUT_WINDOW_BYTES,
  EXEC_TICKET_PARAM,
  ExecClientMessageSchema,
  ExecServerMessageSchema,
} from './exec-protocol';
import {
  IMAGE_BUILD_PATH,
  IMAGE_BUILD_STREAM_TYPE,
  ImageBuildErrorSchema,
  ImageBuildEventSchema,
  ImageBuildQuerySchema,
  ImageBuildResultSchema,
} from './image-build-protocol';
import { impContract } from './imp-contract';
import { IMP_ERRORS } from './imp-errors';
import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_NORMAL,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_CLOSE_RESTARTING,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PATH,
  TUNNEL_WINDOW_BYTES,
  TunnelClientMessageSchema,
  TunnelServerMessageSchema,
} from './tunnel-protocol';

const JsonSchemaSchema = z.record(z.string(), z.unknown()).readonly();

type JsonSchema = z.infer<typeof JsonSchemaSchema>;

// `toServer`: a client sends it and impd reads it; `toClient`: the reverse
const MessageDirectionSchema = z.enum(['toServer', 'toClient']);

export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

const ProcedureSchemaSchema = z
  .object({
    input: JsonSchemaSchema,
    output: JsonSchemaSchema,

    // an event iterator, whose output is the schema of each event
    stream: z.boolean(),
  })
  .readonly();

const MessageSchemaSchema = z
  .object({ direction: MessageDirectionSchema, schema: JsonSchemaSchema })
  .readonly();

const ErrorSchemaSchema = z
  .object({
    // null for a common oRPC code, whose status oRPC fixes
    status: z.number().nullable(),
    data: JsonSchemaSchema,
  })
  .readonly();

// the shape of packages/api/protocol-schema.json, which the check reads back
export const ProtocolSchemaSchema = z
  .object({
    procedures: z.record(z.string(), ProcedureSchemaSchema).readonly(),
    messages: z.record(z.string(), MessageSchemaSchema).readonly(),
    errors: z.record(z.string(), ErrorSchemaSchema).readonly(),
    constants: z.record(z.string(), z.unknown()).readonly(),
  })
  .readonly();

export type ProtocolSchema = z.infer<typeof ProtocolSchemaSchema>;

type ProcedureSchema = z.infer<typeof ProcedureSchemaSchema>;

type MessageSchema = z.infer<typeof MessageSchemaSchema>;

// What a client and impd agree on, as JSON Schema, for the breaking-change
// check: docs/runbooks/releasing.md#breaking-changes.
export function buildProtocolSchema(): ProtocolSchema {
  return {
    procedures: collectProcedures(impContract, []),
    messages: {
      'exec.client': toMessage('toServer', ExecClientMessageSchema),
      'exec.server': toMessage('toClient', ExecServerMessageSchema),
      'tunnel.client': toMessage('toServer', TunnelClientMessageSchema),
      'tunnel.server': toMessage('toClient', TunnelServerMessageSchema),
      'imageBuild.query': toMessage('toServer', ImageBuildQuerySchema),
      'imageBuild.event': toMessage('toClient', ImageBuildEventSchema),
      'imageBuild.result': toMessage('toClient', ImageBuildResultSchema),
      'imageBuild.error': toMessage('toClient', ImageBuildErrorSchema),
    },
    errors: Object.fromEntries(
      Object.entries(IMP_ERRORS).map(([code, error]) => {
        const status = 'status' in error && typeof error.status === 'number' ? error.status : null;
        const data = 'data' in error ? error.data : undefined;

        return [code, { status, data: buildJsonSchema(data, 'output') }];
      }),
    ),
    constants: {
      EXEC_PATH,
      EXEC_TICKET_PARAM,
      EXEC_CLOSE_RESTARTING,
      EXEC_CHANNELS,
      EXEC_STDIN_WINDOW_BYTES,
      EXEC_MAX_STDIN_FRAME_BYTES,
      EXEC_STDOUT_WINDOW_BYTES,
      IMAGE_BUILD_PATH,
      IMAGE_BUILD_STREAM_TYPE,
      TUNNEL_PATH,
      TUNNEL_CLOSE_NORMAL,
      TUNNEL_CLOSE_PROTOCOL,
      TUNNEL_CLOSE_RESTARTING,
      TUNNEL_CLOSE_LOST,
      TUNNEL_WINDOW_BYTES,
      TUNNEL_MAX_FRAME_BYTES,
    },
  };
}

// a procedure's path is its RPC path, `imps.create` for /rpc/imps/create
function collectProcedures(
  node: unknown,
  path: readonly string[],
): Record<string, ProcedureSchema> {
  if (isProcedure(node)) {
    const definition = node['~orpc'];
    const events = getEventIteratorSchemaDetails(definition.outputSchema);
    const output = events === undefined ? definition.outputSchema : events.yields;

    return {
      [path.join('.')]: {
        input: buildJsonSchema(definition.inputSchema, 'input'),
        output: buildJsonSchema(output, 'output'),
        stream: events !== undefined,
      },
    };
  }

  if (typeof node !== 'object' || node === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(node).flatMap(([key, child]) =>
      Object.entries(collectProcedures(child, [...path, key])),
    ),
  );
}

interface Procedure {
  readonly '~orpc': {
    readonly inputSchema?: AnySchema;
    readonly outputSchema?: AnySchema;
  };
}

function isProcedure(node: unknown): node is Procedure {
  return isContractProcedure(node);
}

// A message on the wire is what its reader parses, so it is the schema's input.
function toMessage(direction: MessageDirection, schema: unknown): MessageSchema {
  return { direction, schema: buildJsonSchema(schema, 'input') };
}

// oRPC's serializer carries a Date as itself. A custom type or a transform,
// which JSON Schema cannot express, becomes any value, tagged with its kind.
function buildJsonSchema(schema: unknown, io: 'input' | 'output'): JsonSchema {
  if (schema === undefined) {
    return {};
  }

  if (!(schema instanceof z.ZodType)) {
    throw new TypeError('the protocol schema reads zod schemas only');
  }

  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    override: (context) => {
      const zodSchema = context.zodSchema;

      if (zodSchema instanceof z.ZodDate) {
        context.jsonSchema.type = 'string';
        context.jsonSchema.format = 'date-time';
      } else if (zodSchema instanceof z.ZodCustom) {
        context.jsonSchema['x-unrepresentable'] = 'custom';
      } else if (zodSchema instanceof z.ZodTransform) {
        context.jsonSchema['x-unrepresentable'] = 'transform';
      }
    },
  });

  return json;
}
