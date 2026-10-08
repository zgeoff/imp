import { faker } from '@faker-js/faker';
import { EgressPolicySchema, NameSchema } from '@imp/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

// each imp's egress policy, which impd keeps beside the imp: open by default
const ImpPolicyRowSchema = z.object({
  imp: NameSchema.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),
  policy: EgressPolicySchema.default(() => ({ mode: 'open' as const, allow: [] })),
});

export const impPolicyCollection = new Collection({ schema: ImpPolicyRowSchema });
