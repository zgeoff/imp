import { faker } from '@faker-js/faker';
import type { PublicImp } from '../db/exposure';
import { buildMockStoredPublicAuth } from './build-mock-stored-public-auth';

// A public imp as findPublicImp reads it: a running imp with an arbitrary id
// and basic auth for an arbitrary user.
export function buildMockPublicImp(overrides: Partial<PublicImp> = {}): PublicImp {
  return {
    id: faker.string.uuid(),
    state: 'running',
    stored: buildMockStoredPublicAuth(),
    ...overrides,
  };
}
