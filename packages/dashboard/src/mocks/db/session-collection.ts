import { faker } from '@faker-js/faker';
import { SESSION_MAX_AGE_S } from '@imp/daemon/src/auth/session-cookie';
import { Collection } from '@msw/data';
import * as z from 'zod';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// The session cookie of the one browser a test drives, which Bun's fetch
// cannot keep: the id of the token it was made with, as impd's `tokenId`,
// read again on each request, and its expiry, 30 days on as impd's
const SessionRowSchema = z.object({
  tokenId: z.string().default(() => faker.string.fromCharacters(BASE64URL, 16)),
  expiresAt: z.date().default(() => new Date(Date.now() + SESSION_MAX_AGE_S * 1000)),
});

export const sessionCollection = new Collection({ schema: SessionRowSchema });
