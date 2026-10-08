import { faker } from '@faker-js/faker';
import { IdentitySchema } from '@imp/api';
import { Collection } from '@msw/data';

// The session cookie of the one browser a test drives, which Bun's fetch
// cannot keep, as the identity it stands for; without a row every RPC call
// gets impd's 401. By default, made with a manage token for every imp.
const SessionRowSchema = IdentitySchema.extend({
  kind: IdentitySchema.shape.kind.default('dashboard'),
  name: IdentitySchema.shape.name.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),
  scope: IdentitySchema.shape.scope.default('manage'),
  imps: IdentitySchema.shape.imps.default(null),
});

export const sessionCollection = new Collection({ schema: SessionRowSchema });
