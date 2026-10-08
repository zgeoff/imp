import { faker } from '@faker-js/faker';
import { TokenSchema } from '@imp/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

// impd's API tokens, each with the secret `/auth/login` takes for it: a read
// token for every imp, with no SSH keys and nothing to grant
const TokenRowSchema = TokenSchema.extend({
  name: TokenSchema.shape.name.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),
  scope: TokenSchema.shape.scope.default('read'),
  imps: TokenSchema.shape.imps.default(null),
  sshKeys: TokenSchema.shape.sshKeys.default([]),
  createdAt: z.date().default(() => faker.date.past()),

  // impd's `imp_<id>.<secret>` (packages/daemon auth/token-store.ts)
  secret: z
    .string()
    .default(
      () =>
        `imp_${faker.string.alphanumeric({ length: 12, casing: 'lower' })}.${faker.string.alphanumeric(43)}`,
    ),
});

export const tokenCollection = new Collection({ schema: TokenRowSchema });
