import { ScalarType, fromJson } from '@bufbuild/protobuf';
import type { DescField, DescMessage, JsonValue, MessageShape } from '@bufbuild/protobuf';

// One agent message from its JSON (proto/imp/agent/v1/agent.proto). A field
// this impd does not know is dropped, as a newer agent may send one; a field
// of the wrong type throws, and so does a count that is not one.
export function decodeAgentMessage<Desc extends DescMessage>(
  schema: Desc,
  json: JsonValue,
): MessageShape<Desc> {
  const message = fromJson(schema, json, { ignoreUnknownFields: true });
  const bad = findBadCount(schema, message);

  if (bad !== undefined) {
    throw new Error(`${bad}: the agent sent a number out of its range`);
  }

  return message;
}

// the doubles that are not counts, which need only be finite
const NON_COUNT_FIELDS = new Set(['imp.agent.v1.Activity.load1']);

// The full name of the first double that is not a count. A double's JSON form
// reads "NaN", "Infinity", fractions and negatives, and impd puts offsets in
// log bounds and file metadata.
function findBadCount(schema: DescMessage, message: object): string | undefined {
  for (const field of schema.fields) {
    const value: unknown = Reflect.get(message, field.localName);
    const items: unknown[] = Array.isArray(value) ? value : [value];

    for (const item of items) {
      const bad = findBadFieldValue(field, item);

      if (bad !== undefined) {
        return bad;
      }
    }
  }

  return undefined;
}

function findBadFieldValue(field: DescField, value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && field.message !== undefined) {
    return findBadCount(field.message, value);
  }

  if (typeof value !== 'number' || field.scalar !== ScalarType.DOUBLE) {
    return undefined;
  }

  const name = `${field.parent.typeName}.${field.name}`;

  const isGood = NON_COUNT_FIELDS.has(name)
    ? Number.isFinite(value)
    : Number.isSafeInteger(value) && value >= 0;

  return isGood ? undefined : name;
}
