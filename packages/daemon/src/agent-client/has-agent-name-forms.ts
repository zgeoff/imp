import { isMessage } from '@bufbuild/protobuf';
import type { Message } from '@bufbuild/protobuf';
import { AgentBootIdSchema, AgentGenerationSchema, AgentSessionNameSchema } from './agent-ids';

// Whether every name, generation and boot ID in an agent message has the form
// the real agent gives it (docs/architecture/guest/protocol.md#trust). Only a
// listed session may leave its generation empty, as agents before offsets do.
export function hasAgentNameForms(message: Message): boolean {
  return Object.entries(message).every(([key, value]) =>
    hasFieldForm(message.$typeName, key, value),
  );
}

// the fields that hold a session's name
const SESSION_NAME_FIELDS = new Set([
  'imp.agent.v1.SessionInfo.name',
  'imp.agent.v1.Started.session',
]);

function hasFieldForm(typeName: string, key: string, value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (key === 'executionGeneration') {
    return (
      (value === '' && typeName === 'imp.agent.v1.SessionInfo') ||
      AgentGenerationSchema.safeParse(value).success
    );
  }

  if (key === 'bootId') {
    return AgentBootIdSchema.safeParse(value).success;
  }

  if (SESSION_NAME_FIELDS.has(`${typeName}.${key}`)) {
    return AgentSessionNameSchema.safeParse(value).success;
  }

  if (Array.isArray(value)) {
    return value.every((item) => !isMessage(item) || hasAgentNameForms(item));
  }

  return !isMessage(value) || hasAgentNameForms(value);
}
