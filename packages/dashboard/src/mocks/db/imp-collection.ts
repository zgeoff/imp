import { faker } from '@faker-js/faker';
import { ImpSchema } from '@imp/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

// impd's imps: a running imp with every optional field left out
export const ImpRowSchema = ImpSchema.extend({
  id: z.string().default(() => faker.string.uuid()),
  name: ImpSchema.shape.name.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),
  image: ImpSchema.shape.image.default(() => faker.string.alpha({ length: 6, casing: 'lower' })),
  state: ImpSchema.shape.state.default('running'),
  vcpus: z
    .int()
    .positive()
    .default(() => faker.number.int({ min: 1, max: 8 })),
  memoryMib: z
    .int()
    .positive()
    .default(() => faker.number.int({ min: 1, max: 32 }) * 128),
  diskMib: z
    .int()
    .positive()
    .default(() => faker.number.int({ min: 1, max: 64 }) * 1024),
  ip: z.ipv4().default(() => faker.internet.ipv4()),
  slot: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 0, max: 250 })),
  port: z
    .int()
    .positive()
    .default(() => faker.number.int({ min: 20_000, max: 29_999 })),
  httpPort: z
    .int()
    .positive()
    .default(() => faker.number.int({ min: 1024, max: 65_535 })),
  url: z.url().default(() => faker.internet.url()),
  createdAt: z.date().default(() => faker.date.past()),
  lastActiveAt: z.date().default(() => faker.date.recent()),

  // impd gives every imp its CPU settings: no limit, weight 100
  cpu: ImpSchema.shape.cpu.unwrap().default(() => ({ limit: null, weight: 100 })),
});

export const impCollection = new Collection({ schema: ImpRowSchema });
