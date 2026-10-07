import { expect, test } from 'bun:test';
import type { Imp } from '@imp/api';
import { EVENT_VERSION } from '@imp/api';
import { buildMockImpChangedEvent } from './build-mock-imp-changed-event';

test('it builds a default imp changed event', () => {
  expect(buildMockImpChangedEvent()).toStrictEqual({
    v: EVENT_VERSION,
    at: expect.toBeValidDate(),
    ev: 'ImpChanged',
    reason: 'updated',
    imp: expect.toSatisfy((imp: Imp) => imp.state === 'running'),
  });
});

test('it applies overrides on top of the defaults', () => {
  const event = buildMockImpChangedEvent({
    reason: 'slept',
    imp: { name: 'web', state: 'sleeping' },
  });

  expect(event).toStrictEqual({
    v: EVENT_VERSION,
    at: expect.toBeValidDate(),
    ev: 'ImpChanged',
    reason: 'slept',
    imp: expect.toSatisfy((imp: Imp) => imp.name === 'web' && imp.state === 'sleeping'),
  });
});
