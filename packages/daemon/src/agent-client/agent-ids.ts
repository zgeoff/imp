import { ExecutionGenerationSchema, SessionNameSchema } from '@imp/api';
import * as z from 'zod';

// The names an agent reports that impd uses in paths, file names or logs.
// The guest is not trusted: a replaced agent can send anything, so each
// name is held to the form the real agent makes.

// a generation is 32 lowercase hex characters, as the agent draws them, and
// a session name the rule the agent checks too
export const AgentGenerationSchema = ExecutionGenerationSchema;
export const AgentSessionNameSchema = SessionNameSchema;

// the guest kernel's boot_id, or a claimed boot template's random UUID: a
// lowercase UUID, or empty without procfs
export const AgentBootIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/);

const AgentLogIdentitySchema = z.object({
  generation: AgentGenerationSchema,
  session: AgentSessionNameSchema,
  bootId: AgentBootIdSchema,
});

type AgentLogIdentity = z.infer<typeof AgentLogIdentitySchema>;

// whether the names a session log is made from all have their agent's form;
// impd checks this before it touches the disk for them
export function isAgentLogIdentity(identity: Readonly<AgentLogIdentity>): boolean {
  return AgentLogIdentitySchema.safeParse(identity).success;
}
