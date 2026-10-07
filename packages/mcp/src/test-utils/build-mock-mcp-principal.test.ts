import { expect, test } from 'bun:test';
import { createImpClient } from '@zgeoff/imp-client';
import { createImpGuard } from '../imp-guard';
import { buildMockMcpPrincipal } from './build-mock-mcp-principal';

test('it builds a default mcp principal', () => {
  const principal: unknown = buildMockMcpPrincipal();

  expect(principal).toStrictEqual({
    key: expect.any(String) as unknown,
    scope: 'manage',
    client: expect.objectContaining({ imps: expect.any(Function) as unknown }) as unknown,
    guard: expect.objectContaining({ summary: 'every imp' }) as unknown,
    ends: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  const client = createImpClient({ url: 'http://impd.test' });
  const guard = createImpGuard({ prefix: 'agent-' });

  const ends = new AbortController().signal;

  const principal = buildMockMcpPrincipal({ key: 'alice', scope: 'read', client, guard, ends });

  expect(principal).toStrictEqual({ key: 'alice', scope: 'read', client, guard, ends });
});
