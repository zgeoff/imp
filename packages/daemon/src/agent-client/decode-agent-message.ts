import { fromJson } from '@bufbuild/protobuf';
import type { DescMessage, JsonValue, MessageShape } from '@bufbuild/protobuf';

// One agent message from its JSON (proto/imp/agent/v1/agent.proto). A field
// this impd does not know is dropped, as an agent newer than it may send one,
// as on an imp that moved here; a field of the wrong type throws.
export function decodeAgentMessage<Desc extends DescMessage>(
  schema: Desc,
  json: JsonValue,
): MessageShape<Desc> {
  return fromJson(schema, json, { ignoreUnknownFields: true });
}
