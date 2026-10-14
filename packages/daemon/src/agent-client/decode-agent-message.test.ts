import { expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { ListeningSchema, PingSchema } from './agent-protocol';
import { decodeAgentMessage } from './decode-agent-message';

test('it decodes a message from the agent’s JSON', () => {
  expect(
    decodeAgentMessage(ListeningSchema, { ok: true, port: 41_234, listener: 'l2' }),
  ).toStrictEqual(create(ListeningSchema, { ok: true, port: 41_234, listener: 'l2' }));
});

test('it drops a field a newer agent sends that the schema lacks', () => {
  expect(
    decodeAgentMessage(PingSchema, { ok: true, version: '0.99.0', newer_field: { a: 1 } }),
  ).toStrictEqual(create(PingSchema, { ok: true, version: '0.99.0' }));
});

test('it reads a 64-bit count an agent writes as a string', () => {
  expect(
    decodeAgentMessage(PingSchema, { ok: true, version: '0.18.0', uptime_ms: '5321' }).uptimeMs,
  ).toBe(5321);
});

test('it throws for a field of the wrong type', () => {
  expect(() => decodeAgentMessage(PingSchema, { ok: 'yes', version: '0.18.0' })).toThrow();
});
