import { expect, test } from 'bun:test';
import { buildImpPaths } from '../storage/data-layout';
import { buildMockElasticImp } from './build-mock-elastic-imp';

test('it builds a default elastic imp', () => {
  const imp = buildMockElasticImp();

  expect(imp).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toBeString(),
    pid: expect.toBeNumber(),
    memoryMib: expect.toBeNumber(),
    maxMemoryMib: imp.memoryMib * 2,
    paths: buildImpPaths('/data', imp.id),
    agentVersion: expect.toBeString(),
  });
});

test('it derives the paths and the max from an overridden id and memory', () => {
  const imp = buildMockElasticImp({ id: 'dev', memoryMib: 512 });

  expect(imp.paths).toStrictEqual(buildImpPaths('/data', 'dev'));
  expect(imp.maxMemoryMib).toBe(1024);
});

test('it applies overrides on top of the defaults', () => {
  const imp = buildMockElasticImp({
    id: 'dev',
    name: 'dev',
    pid: 1,
    memoryMib: 512,
    maxMemoryMib: 1536,
    paths: buildImpPaths('/srv', 'dev'),
    agentVersion: undefined,
  });

  expect(imp).toStrictEqual({
    id: 'dev',
    name: 'dev',
    pid: 1,
    memoryMib: 512,
    maxMemoryMib: 1536,
    paths: buildImpPaths('/srv', 'dev'),
    agentVersion: undefined,
  });
});
