import * as z from 'zod';

// The names an agent reports that impd uses in paths, file names or logs.
// The guest is not trusted: a replaced agent can send anything, so each
// name is held to the form the real agent makes.

// a generation is 32 lowercase hex characters, as the agent draws them, and
// a session name the rule the agent checks too
export {
  ExecutionGenerationSchema as AgentGenerationSchema,
  SessionNameSchema as AgentSessionNameSchema,
} from '@imp/api';

// the guest kernel's boot_id, or a claimed boot template's random UUID: a
// lowercase UUID, or empty without procfs
export const AgentBootIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/);
