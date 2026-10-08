import { faker } from '@faker-js/faker';
import { SystemInfoSchema } from '@imp/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

const shape = SystemInfoSchema.shape;

// What system.info says of the host: one row, or these defaults when a test
// seeds none. A host on XFS, off the tailnet, with nothing to boot cold.
export const SystemInfoRowSchema = SystemInfoSchema.extend({
  version: z.string().default(() => faker.system.semver()),
  ramBudgetMib: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 4, max: 64 }) * 1024),
  ramUsedMib: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 0, max: 4096 })),
  ramReservedMib: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 0, max: 1024 })),
  ramCommittedMib: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 0, max: 8192 })),
  awakeCount: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 0, max: 10 })),
  impCount: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 0, max: 20 })),
  sessionCount: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 0, max: 10 })),
  bootStatus: shape.bootStatus.default(() => ({
    coldBoots: 0,
    outdated: { firecracker: 0, kernel: 0, agent: 0 },
  })),
  firecrackerVersion: shape.firecrackerVersion.default(() => `v${faker.system.semver()}`),
  guestKernel: shape.guestKernel.default(() => ({
    version: null,
    sha256: faker.string.hexadecimal({ length: 64, prefix: '' }),
  })),
  systemDrive: shape.systemDrive.default(() => ({
    sha256: faker.string.hexadecimal({ length: 64, prefix: '' }),
  })),
  storage: shape.storage.default(() => ({
    backend: 'xfs' as const,
    usedBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
    availableBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
    reserveBytes: faker.number.int({ min: 0, max: 1024 ** 3 }),
    pendingBytes: 0,
    isLow: false,
    impDiskBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
  })),
  tailscale: shape.tailscale.default(() => ({
    enabled: false,
    state: null,
    hostname: null,
    ip: null,
    names: null,
  })),
});

export const systemInfoCollection = new Collection({ schema: SystemInfoRowSchema });
