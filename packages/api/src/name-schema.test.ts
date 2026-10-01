import { expect, test } from 'bun:test';
import { NameSchema } from './name-schema';

test('it accepts lowercase DNS labels up to 31 characters', () => {
  for (const name of ['a', 'dev', 'my-imp-2', `a${'b'.repeat(30)}`]) {
    expect(NameSchema.safeParse(name).success).toBe(true);
  }
});

test('it rejects names that are not lowercase DNS labels', () => {
  for (const name of ['', '2dev', '-dev', 'Dev', 'my_imp', 'dev.box', `a${'b'.repeat(31)}`]) {
    expect(NameSchema.safeParse(name).success).toBe(false);
  }
});
