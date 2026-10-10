import { faker } from '@faker-js/faker';
import type { AgentSession } from '../agent-client/agent-requests';

// A running session as an agent with output offsets lists it: detached, with
// no exit. The name, process, size, start, generation and boot are
// arbitrary; `log` and `exit` are absent until an override sets them.
export function buildMockAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    name: faker.string.alpha({ length: 8, casing: 'lower' }),
    pid: faker.number.int({ min: 2, max: 65_535 }),
    argv: [faker.system.fileName()],
    state: 'running',
    attached: false,
    cols: faker.number.int({ min: 20, max: 300 }),
    rows: faker.number.int({ min: 10, max: 100 }),
    started_unix_ms: faker.date.past().getTime(),
    execution_generation: faker.string.hexadecimal({ length: 32, casing: 'lower', prefix: '' }),
    boot_id: faker.string.uuid(),
    end: 0,
    ...overrides,
  };
}
