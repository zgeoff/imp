import { faker } from '@faker-js/faker';
import type { ElasticImp } from '../memory/memory-controller';
import { buildImpPaths } from '../storage/data-layout';

// A running imp that may grow, as the memory controller lists it: its paths
// follow its id under /data, and its max is twice its memory.
export function buildMockElasticImp(overrides: Partial<ElasticImp> = {}): ElasticImp {
  const id = overrides.id ?? faker.string.alphanumeric({ length: 12, casing: 'lower' });
  const memoryMib = overrides.memoryMib ?? faker.helpers.arrayElement([256, 512, 1024]);

  return {
    id,
    name: faker.word.noun(),
    pid: faker.number.int({ min: 2, max: 4_194_304 }),
    memoryMib,
    maxMemoryMib: memoryMib * 2,
    paths: buildImpPaths('/data', id),
    agentVersion: faker.system.semver(),
    ...overrides,
  };
}
