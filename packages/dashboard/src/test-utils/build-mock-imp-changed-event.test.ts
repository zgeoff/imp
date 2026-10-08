import { expect, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import { buildMockImpChangedEvent } from './build-mock-imp-changed-event';

test('it builds a default imp changed event', () => {
  expect(buildMockImpChangedEvent()).toStrictEqual({
    v: EVENT_VERSION,
    at: expect.toBeValidDate(),
    ev: 'ImpChanged',
    reason: 'updated',
    imp: {
      id: expect.toBeString(),
      name: expect.toBeString(),
      image: expect.toBeString(),
      state: 'running',
      vcpus: expect.toBeNumber(),
      memoryMib: expect.toBeNumber(),
      diskMib: expect.toBeNumber(),
      ip: expect.toBeString(),
      slot: expect.toBeNumber(),
      port: expect.toBeNumber(),
      httpPort: expect.toBeNumber(),
      url: expect.toBeString(),
      createdAt: expect.toBeValidDate(),
      lastActiveAt: expect.toBeValidDate(),
      cpu: { limit: null, weight: 100 },
    },
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
    imp: {
      id: expect.toBeString(),
      name: 'web',
      image: expect.toBeString(),
      state: 'sleeping',
      vcpus: expect.toBeNumber(),
      memoryMib: expect.toBeNumber(),
      diskMib: expect.toBeNumber(),
      ip: expect.toBeString(),
      slot: expect.toBeNumber(),
      port: expect.toBeNumber(),
      httpPort: expect.toBeNumber(),
      url: expect.toBeString(),
      createdAt: expect.toBeValidDate(),
      lastActiveAt: expect.toBeValidDate(),
      cpu: { limit: null, weight: 100 },
    },
  });
});
