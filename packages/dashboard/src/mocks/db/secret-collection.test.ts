import { expect, test } from 'bun:test';
import { secretCollection } from './secret-collection';

test('it creates a default secret', async () => {
  const secret: { readonly name: string; readonly generation: string } =
    await secretCollection.create({});

  expect(secret).toStrictEqual({
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    generation: expect.toBeString(),
  });
});

test('it applies overrides on top of the defaults', async () => {
  const secret: { readonly name: string; readonly generation: string } =
    await secretCollection.create({ name: 'npm' });

  expect(secret).toStrictEqual({ name: 'npm', generation: expect.toBeString() });
});
