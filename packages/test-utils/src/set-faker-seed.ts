import { faker as sharedFaker } from '@faker-js/faker';
import type { Faker } from '@faker-js/faker';

// Seeds faker once for the whole run and fixes the date its relative dates
// count from, so a failing run's factory values come out the same next run.
// oxlint-disable-next-line prefer-readonly-parameter-types -- seeding changes the instance
export function setFakerSeed(faker: Faker = sharedFaker): void {
  faker.seed(135);
  faker.setDefaultRefDate(new Date('2026-01-01T00:00:00.000Z'));
}
