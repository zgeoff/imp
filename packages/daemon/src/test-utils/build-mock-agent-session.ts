import { create } from '@bufbuild/protobuf';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { faker } from '@faker-js/faker';
import { SessionInfoSchema } from '../agent-client/agent-protocol';
import type { SessionInfo } from '../agent-client/agent-protocol';

// A running session as an agent with output offsets lists it: detached, with
// no exit. The name, process, size, start, generation and boot are
// arbitrary; `log` and `exit` are unset until an override sets them.
export function buildMockAgentSession(
  overrides: MessageInitShape<typeof SessionInfoSchema> = {},
): SessionInfo {
  return create(SessionInfoSchema, {
    name: faker.string.alpha({ length: 8, casing: 'lower' }),
    pid: faker.number.int({ min: 2, max: 65_535 }),
    argv: [faker.system.fileName()],
    state: 'running',
    attached: false,
    cols: faker.number.int({ min: 20, max: 300 }),
    rows: faker.number.int({ min: 10, max: 100 }),
    startedUnixMs: faker.date.past().getTime(),
    executionGeneration: faker.string.hexadecimal({ length: 32, casing: 'lower', prefix: '' }),
    bootId: faker.string.uuid(),
    end: 0,
    ...overrides,
  });
}
