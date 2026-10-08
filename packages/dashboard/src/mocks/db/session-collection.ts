import { faker } from '@faker-js/faker';
import { NameSchema } from '@imp/api';
import { SESSION_MAX_AGE_S } from '@imp/daemon/src/auth/session-cookie';
import { Collection } from '@msw/data';
import * as z from 'zod';

// The session cookie of the one browser a test drives, which Bun's fetch
// cannot keep: the token it was made with, read again on each request, and
// its expiry, 30 days on as impd's
const SessionRowSchema = z.object({
  token: NameSchema.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),
  expiresAt: z.date().default(() => new Date(Date.now() + SESSION_MAX_AGE_S * 1000)),
});

export const sessionCollection = new Collection({ schema: SessionRowSchema });
