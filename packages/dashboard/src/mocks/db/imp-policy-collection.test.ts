import { expect, test } from 'bun:test';
import type { EgressPolicy } from '@imp/api';
import { impPolicyCollection } from './imp-policy-collection';

test('it creates a default open policy', async () => {
  const row: { readonly imp: string; readonly policy: EgressPolicy } =
    await impPolicyCollection.create({});

  expect(row).toStrictEqual({
    imp: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    policy: { mode: 'open', allow: [] },
  });
});

test('it applies overrides on top of the defaults', async () => {
  const row: { readonly imp: string; readonly policy: EgressPolicy } =
    await impPolicyCollection.create({ imp: 'web', policy: { mode: 'none', allow: [] } });

  expect(row).toStrictEqual({ imp: 'web', policy: { mode: 'none', allow: [] } });
});
