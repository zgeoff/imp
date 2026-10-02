import * as z from 'zod';
import { NameSchema } from './name-schema';

// Who reaches an imp at https://<name>.<domain>: the tailnet only, or the
// internet too, through impd's public listeners (docs/guides/https.md#public-imps).
export const ExposureSchema = z.enum(['tailnet', 'public']);

export type Exposure = z.infer<typeof ExposureSchema>;

// What a public imp asks for before the wake: nothing, a bearer token, or
// basic auth. impd makes the token or the password and shows it once.
export const PublicAuthSchema = z.enum(['none', 'token', 'basic']);

export type PublicAuth = z.infer<typeof PublicAuthSchema>;

// a basic auth user name: no colon, which ends the user in the header
export const BasicUserSchema = z
  .string()
  .regex(/^[!-9;-~]{1,64}$/, 'must be 1 to 64 printable characters, without a colon');

export const ExposeInputSchema = z
  .object({
    name: NameSchema,

    // token unless the caller asks: a public imp is never open by default
    auth: PublicAuthSchema.default('token'),

    // basic auth's user name; `imp` when left out
    user: BasicUserSchema.optional(),
  })
  .refine((input) => input.auth === 'basic' || input.user === undefined, {
    message: 'only basic auth takes a user',
    path: ['user'],
  });

export const ExposeResultSchema = z.object({
  url: z.url(),
  auth: PublicAuthSchema,
  user: z.string().nullable(),

  // the token or the password, shown this once; null without auth
  credential: z.string().nullable(),

  // set when the imp's DNS record could not be written yet; impd tries
  // again every 10 minutes
  warning: z.string().optional(),
});

export type ExposeResult = z.infer<typeof ExposeResultSchema>;
