import * as z from 'zod';

// A DNS label, so a name works as the `<name>.imp.localhost` host and as a
// guest hostname without escaping.
export const NameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,30}$/,
    'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  );
