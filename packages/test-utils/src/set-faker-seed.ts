import { faker } from '@faker-js/faker';

// Seeds faker once for the whole run and fixes the date its relative dates
// count from, so a failing run's factory values come out the same next run.
export function setFakerSeed(): void {
  faker.seed(135);
  faker.setDefaultRefDate(new Date('2026-01-01T00:00:00.000Z'));
}
