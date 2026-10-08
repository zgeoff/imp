import { expect, test } from 'bun:test';
import type { Imp } from '@imp/api';
import { impCollection } from './imp-collection';

test('it creates a default imp', async () => {
  const imp: Imp = await impCollection.create({});

  expect(imp).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    image: expect.toSatisfy((value: string) => /^[a-z]{6}$/.test(value)),
    state: 'running',
    vcpus: expect.toBeWithin(1, 9),
    memoryMib: expect.toSatisfy((mib: number) => mib >= 128 && mib % 128 === 0),
    diskMib: expect.toSatisfy((mib: number) => mib >= 1024 && mib % 1024 === 0),
    ip: expect.toSatisfy((value: string) => /^\d+\.\d+\.\d+\.\d+$/.test(value)),
    slot: expect.toBeWithin(0, 251),
    port: expect.toBeWithin(20_000, 30_000),
    httpPort: expect.toBeWithin(1024, 65_536),
    url: expect.toSatisfy((value: string) => /^https?:\/\//.test(value)),
    createdAt: expect.toBeValidDate(),
    lastActiveAt: expect.toBeValidDate(),
  });
});

test('it applies overrides on top of the defaults', async () => {
  const imp: Imp = await impCollection.create({ name: 'web', state: 'sleeping', ramMib: 300 });

  expect(imp).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    image: expect.toBeString(),
    state: 'sleeping',
    vcpus: expect.toBeNumber(),
    memoryMib: expect.toBeNumber(),
    diskMib: expect.toBeNumber(),
    ip: expect.toBeString(),
    slot: expect.toBeNumber(),
    port: expect.toBeNumber(),
    httpPort: expect.toBeNumber(),
    url: expect.toBeString(),
    createdAt: expect.toBeValidDate(),
    lastActiveAt: expect.toBeValidDate(),
    ramMib: 300,
  });
});
