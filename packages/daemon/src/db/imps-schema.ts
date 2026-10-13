import * as z from 'zod';

// A token's or OAuth grant's `imps` column: a JSON array of imp patterns, or
// null for every imp and the host
export const ImpsSchema = z.array(z.string()).nullable();
