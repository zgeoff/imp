import { expect, test } from 'bun:test';
import { faker } from '@faker-js/faker';
import { setFakerSeed } from './set-faker-seed';

test('it makes faker values repeat after each seeding', () => {
  setFakerSeed();

  const first = [faker.string.uuid(), faker.date.recent().toISOString()];

  setFakerSeed();

  const second = [faker.string.uuid(), faker.date.recent().toISOString()];

  expect(second).toStrictEqual(first);
});

test('it counts relative dates from a fixed day', () => {
  setFakerSeed();

  expect(faker.date.recent()).toBeBetween(
    new Date('2025-12-31T00:00:00.000Z'),
    new Date('2026-01-01T00:00:00.000Z'),
  );
});
