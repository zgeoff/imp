import { expect, test } from 'bun:test';
import type { Checkpoint } from '@imp/api';
import { checkpointCollection } from './checkpoint-collection';

test('it creates a default checkpoint without a label', async () => {
  const checkpoint: Checkpoint & { readonly imp: string } = await checkpointCollection.create({});

  expect(checkpoint).toStrictEqual({
    imp: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    id: expect.toSatisfy((value: string) => /^[a-z0-9]{10}$/.test(value)),
    createdAt: expect.toBeValidDate(),
    diskMib: expect.toSatisfy((mib: number) => mib >= 1024 && mib % 1024 === 0),
  });
});

test('it applies overrides on top of the defaults', async () => {
  const checkpoint: Checkpoint & { readonly imp: string } = await checkpointCollection.create({
    imp: 'web',
    id: 'cp1',
    label: 'before-upgrade',
  });

  expect(checkpoint).toStrictEqual({
    imp: 'web',
    id: 'cp1',
    label: 'before-upgrade',
    createdAt: expect.toBeValidDate(),
    diskMib: expect.toBeNumber(),
  });
});
