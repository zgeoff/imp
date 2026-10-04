import { expect, test } from 'bun:test';
import {
  AgentBootIdSchema,
  AgentGenerationSchema,
  AgentSessionNameSchema,
  isAgentLogIdentity,
} from './agent-ids';
import { HOSTILE_BOOT_IDS, HOSTILE_GENERATIONS, HOSTILE_SESSION_NAMES } from './test-agent-ids';

const GENERATION = 'a'.repeat(32);
const BOOT = '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11';

test('the ids a real agent sends pass', () => {
  expect(AgentGenerationSchema.safeParse(GENERATION).success).toBe(true);
  expect(AgentBootIdSchema.safeParse(BOOT).success).toBe(true);
  expect(AgentBootIdSchema.safeParse('').success).toBe(true);
  expect(AgentSessionNameSchema.safeParse('main').success).toBe(true);
  expect(isAgentLogIdentity({ generation: GENERATION, session: 'main', bootId: BOOT })).toBe(true);
});

test('every hostile generation, boot id and session name fails', () => {
  const passed = [
    ...HOSTILE_GENERATIONS.filter((value) => AgentGenerationSchema.safeParse(value).success),
    ...HOSTILE_BOOT_IDS.filter((value) => AgentBootIdSchema.safeParse(value).success),
    ...HOSTILE_SESSION_NAMES.filter((value) => AgentSessionNameSchema.safeParse(value).success),
  ];

  expect(passed).toEqual([]);

  const identities = [
    ...HOSTILE_GENERATIONS.map((generation) => ({ generation, session: 'main', bootId: BOOT })),
    ...HOSTILE_BOOT_IDS.map((bootId) => ({ generation: GENERATION, session: 'main', bootId })),
    ...HOSTILE_SESSION_NAMES.map((session) => ({ generation: GENERATION, session, bootId: BOOT })),
  ];

  expect(identities.filter((identity) => isAgentLogIdentity(identity))).toEqual([]);
});
