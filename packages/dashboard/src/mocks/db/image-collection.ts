import { faker } from '@faker-js/faker';
import { ImageSchema } from '@imp/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

// impd's images: one pulled from a registry
const ImageRowSchema = ImageSchema.extend({
  id: z.string().default(() => faker.string.uuid()),
  name: ImageSchema.shape.name.default(() => faker.string.alpha({ length: 6, casing: 'lower' })),
  ref: z
    .string()
    .default(
      () => `docker.io/library/${faker.string.alpha({ length: 6, casing: 'lower' })}:latest`,
    ),
  digest: z
    .string()
    .default(
      () => `sha256:${faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' })}`,
    ),
  source: ImageSchema.shape.source.default('oci'),
  createdAt: z.date().default(() => faker.date.past()),
  sizeBytes: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 1, max: 4096 }) * 1024 * 1024),
});

export const imageCollection = new Collection({ schema: ImageRowSchema });
