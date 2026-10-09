import { expect, test } from 'bun:test';
import { BrokerRuleSchema } from '../secret-schema';
import { buildMockBrokerRule } from './build-mock-broker-rule';

test('it builds a default broker rule', () => {
  const rule = buildMockBrokerRule();
  const parsed: unknown = BrokerRuleSchema.safeParse(rule).data;
  const received: unknown = rule;

  expect(received).toStrictEqual({
    host: expect.stringMatching(/^[a-z0-9.-]+\.[a-z]+$/) as unknown,
    header: 'authorization',
    scheme: 'bearer',
  });

  expect(parsed).toStrictEqual(rule);
});

test('it applies overrides on top of the defaults', () => {
  const rule: unknown = buildMockBrokerRule({
    host: 'github.com',
    scheme: 'basic',
    user: 'x-access-token',
  });

  expect(rule).toStrictEqual({
    host: 'github.com',
    header: 'authorization',
    scheme: 'basic',
    user: 'x-access-token',
  });
});
