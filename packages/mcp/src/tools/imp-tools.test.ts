import { expect, test } from 'bun:test';
import type { Imp } from '@imp/api';
import * as z from 'zod';
import { buildFakeClient, setupServerTest } from '../test-server';

const ResultSchema = z.object({ structuredContent: z.record(z.string(), z.unknown()) });

// what an impd from before the grants report answers a fork with
const OLD_FORK: Imp = {
  id: 'imp-1',
  name: 'dev-b',
  image: 'base',
  state: 'running',
  vcpus: 1,
  memoryMib: 512,
  diskMib: 1024,
  ip: '10.0.0.2',
  slot: 1,
  port: 7001,
  httpPort: 8080,
  url: 'http://dev-b.example.com',
  createdAt: new Date(0),
  lastActiveAt: new Date(0),
};

test('imp_fork against an impd before the report leaves grantsNotCopied out, never empty', async () => {
  const fake = buildFakeClient();

  const ctx = setupServerTest({
    client: { ...fake, imps: { ...fake.imps, fork: () => Promise.resolve(OLD_FORK) } },
  });

  const response = await ctx.sendRequest('tools/call', {
    name: 'imp_fork',
    arguments: { source: 'dev-a', name: 'dev-b' },
  });

  const result = ResultSchema.parse(response?.result);

  expect(result.structuredContent).toMatchObject({ imp: { name: 'dev-b' } });
  expect(result.structuredContent).not.toHaveProperty('grantsNotCopied');
  expect(result.structuredContent).not.toHaveProperty('grantsError');
});
