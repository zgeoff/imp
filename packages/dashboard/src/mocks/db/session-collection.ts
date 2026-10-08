import { faker } from '@faker-js/faker';
import { IdentitySchema } from '@imp/api';
import { SESSION_MAX_AGE_S } from '@imp/daemon/src/auth/session-cookie';
import { Collection } from '@msw/data';
import * as z from 'zod';

// The session cookie of the one browser a test drives, which Bun's fetch
// cannot keep: the identity it stands for and its expiry. By default, a
// fresh session made with a manage token for every imp.
const SessionRowSchema = IdentitySchema.extend({
  kind: IdentitySchema.shape.kind.default('dashboard'),
  name: IdentitySchema.shape.name.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),
  scope: IdentitySchema.shape.scope.default('manage'),
  imps: IdentitySchema.shape.imps.default(null),
  expiresAt: z.date().default(() => new Date(Date.now() + SESSION_MAX_AGE_S * 1000)),
});

export const sessionCollection = new Collection({ schema: SessionRowSchema });
