// The error codes the agent sends (agent/internal/proto/messages.go); the
// error-codes fixture in agent/internal/contract holds the two lists alike.
export const AGENT_ERROR_CODES = [
  'BAD_REQUEST',
  'DIAL_FAILED',
  'EXEC_FAILED',
  'FROZEN',

  // the inner container, where every process runs, is down
  'INNER_DOWN',
  'INTERNAL',

  // a resume named an offset past the end of the generation it names
  'INVALID_RESUME',
  'LISTEN_FAILED',
  'NO_CONNECTION',
  'NO_SERVICE',
  'NO_SESSION',
  'POWERING_OFF',
  'SERVICE_EXISTS',
  'SESSION_LIMIT',
  'UNKNOWN_OP',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];
