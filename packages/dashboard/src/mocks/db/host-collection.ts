import { faker } from '@faker-js/faker';
import { NameSchema, SystemInfoSchema } from '@imp/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

const info = SystemInfoSchema.shape;

// What impd reads from its config and the host rather than from its imps:
// one row, or these defaults, which the first read keeps. A host on XFS,
// off the tailnet, without KSM, a public IP or HTTPS, on impd's defaults.
const HostRowSchema = z.object({
  version: z.string().default(() => faker.system.semver()),
  ramBudgetMib: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 4, max: 64 }) * 1024),

  // the governor's reservations for boots under way
  ramReservedMib: z.int().nonnegative().default(0),
  firecrackerVersion: info.firecrackerVersion.default(() => `v${faker.system.semver()}`),
  guestKernel: info.guestKernel.default(() => ({
    version: null,
    sha256: faker.string.hexadecimal({ length: 64, prefix: '' }),
  })),
  systemDrive: info.systemDrive.default(() => ({
    sha256: faker.string.hexadecimal({ length: 64, prefix: '' }),
  })),
  backend: info.storage.shape.backend.default('xfs'),

  // the data filesystem's numbers; impd adds up the imps' disks itself
  disk: info.storage.omit({ backend: true, impDiskBytes: true }).default(() => ({
    usedBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
    availableBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
    reserveBytes: faker.number.int({ min: 0, max: 1024 ** 3 }),
    pendingBytes: 0,
    isLow: false,
  })),
  tailscale: info.tailscale.default(() => ({
    enabled: false,
    state: null,
    hostname: null,
    ip: null,
    names: null,
  })),
  cpu: z
    .object({ hostCpus: z.int().positive(), limitsEnforced: z.boolean() })
    .default(() => ({ hostCpus: faker.number.int({ min: 2, max: 64 }), limitsEnforced: true })),

  // IMP_DEFAULT_IMAGE, IMP_DEFAULT_MEMORY_MIB and IMP_DEFAULT_VCPUS
  defaultImage: NameSchema.default('base'),
  defaultMemoryMib: z.int().positive().default(2048),
  defaultVcpus: z.int().positive().default(2),
  isEgressEnforced: z.boolean().default(true),

  // the host's KSM numbers, with KSM on
  ksm: z
    .object({
      running: z.boolean(),
      sharedMib: z.int().nonnegative(),
      profitMib: z.int(),
      zeroMib: z.int().nonnegative(),
      headroomMib: z.int().nonnegative(),
    })
    .nullable()
    .default(null),

  // IMP_PUBLIC_IP and the public records' last pass
  publicIp: z.ipv4().nullable().default(null),
  publicRecords: z
    .object({ isOk: z.boolean(), error: z.string().nullable(), at: z.date() })
    .nullable()
    .default(null),
  https: info.https.unwrap().default(null),
});

export const hostCollection = new Collection({ schema: HostRowSchema });
