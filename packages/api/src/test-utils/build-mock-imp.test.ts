import { expect, test } from 'bun:test';
import { ImpSchema } from '../imp-schema';
import { buildMockImp } from './build-mock-imp';

test('it builds a default imp', () => {
  const imp: unknown = buildMockImp();
  const parsed: unknown = ImpSchema.safeParse(imp).data;

  expect(imp).toStrictEqual({
    id: expect.any(String) as unknown,
    name: expect.stringMatching(/^[a-z][a-z0-9-]{0,30}$/) as unknown,
    image: expect.stringMatching(/^[a-z][a-z0-9-]{0,30}$/) as unknown,
    state: 'running',
    vcpus: expect.any(Number) as unknown,
    memoryMib: expect.any(Number) as unknown,
    diskMib: expect.any(Number) as unknown,
    ip: expect.any(String) as unknown,
    slot: expect.any(Number) as unknown,
    port: expect.any(Number) as unknown,
    httpPort: expect.any(Number) as unknown,
    url: expect.any(String) as unknown,
    createdAt: expect.toBeValidDate() as unknown,
    lastActiveAt: expect.toBeValidDate() as unknown,
  });

  expect(parsed).toStrictEqual(imp);
});

test('it applies overrides on top of the defaults', () => {
  const imp: unknown = buildMockImp({ name: 'dev-b', state: 'sleeping', vcpus: 2 });

  expect(imp).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'dev-b',
    image: expect.any(String) as unknown,
    state: 'sleeping',
    vcpus: 2,
    memoryMib: expect.any(Number) as unknown,
    diskMib: expect.any(Number) as unknown,
    ip: expect.any(String) as unknown,
    slot: expect.any(Number) as unknown,
    port: expect.any(Number) as unknown,
    httpPort: expect.any(Number) as unknown,
    url: expect.any(String) as unknown,
    createdAt: expect.toBeValidDate() as unknown,
    lastActiveAt: expect.toBeValidDate() as unknown,
  });
});
