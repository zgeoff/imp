import { faker } from '@faker-js/faker';
import type { ZfsEntry } from '../storage/zfs/zfs-commands';

// One row of `zfs list` as impd reads it: a filesystem that is no clone,
// under an arbitrary name.
export function buildMockZfsEntry(overrides: Partial<ZfsEntry> = {}): ZfsEntry {
  return {
    name: `tank/imp/disks/${faker.string.uuid()}`,
    type: 'filesystem',
    origin: null,
    deferDestroy: false,
    ...overrides,
  };
}
