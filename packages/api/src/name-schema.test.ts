import { expect, test } from 'bun:test';
import { NameSchema } from './name-schema';

test.each([['a'], ['dev'], ['my-imp-2'], ['abbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']])(
  'it accepts %s as a name',
  (name) => {
    expect(NameSchema.safeParse(name).data).toBe(name);
  },
);

test.each([
  [''],
  ['2dev'],
  ['-dev'],
  ['Dev'],
  ['my_imp'],
  ['dev.box'],
  ['abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
])('it rejects %s as a name', (name) => {
  const result = NameSchema.safeParse(name);

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: [],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});
