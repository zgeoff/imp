import { faker } from '@faker-js/faker';
import { SecretNameSchema } from '@imp/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

// impd's secrets, as far as a token's grantable list reads them: a name and
// the generation a grant is made at
const SecretRowSchema = z.object({
  name: SecretNameSchema.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),
  generation: z.string().default(() => faker.string.uuid()),
});

export const secretCollection = new Collection({ schema: SecretRowSchema });
