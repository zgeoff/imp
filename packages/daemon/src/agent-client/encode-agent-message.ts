import { create, toJson } from '@bufbuild/protobuf';
import type { DescMessage, JsonValue, MessageInitShape } from '@bufbuild/protobuf';

// One message for the agent, in the JSON every agent reads: the schema's
// field names (proto/imp/agent/v1/agent.proto), and a field left unset or at
// its zero left out, which the agent reads as zero.
export function encodeAgentMessage<Desc extends DescMessage>(
  schema: Desc,
  message: MessageInitShape<Desc>,
): JsonValue {
  return toJson(schema, create(schema, message), { useProtoFieldName: true });
}
