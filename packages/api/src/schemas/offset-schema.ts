import * as z from 'zod';

// a byte offset into a session's output, from its first byte
export const OffsetSchema = z.int().nonnegative();
