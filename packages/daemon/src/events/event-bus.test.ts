import { expect, mock, test } from 'bun:test';
import { createEventBus } from './event-bus';

test('it gives an event to the listeners after one that throws', () => {
  const bus = createEventBus<string>(() => {});
  const heard: string[] = [];

  bus.subscribe((event) => {
    heard.push(`first ${event}`);
  });

  bus.subscribe(() => {
    throw new Error('the listener broke');
  });

  bus.subscribe((event) => {
    heard.push(`last ${event}`);
  });

  bus.publish('tick');

  expect(heard).toStrictEqual(['first tick', 'last tick']);
});

test('it keeps a throwing listener’s error from the publisher', () => {
  const bus = createEventBus<string>(() => {});

  bus.subscribe(() => {
    throw new Error('the listener broke');
  });

  expect(() => {
    bus.publish('tick');
  }).not.toThrow();
});

test('it logs the error of a listener that throws', () => {
  const log = mock();
  const bus = createEventBus<string>(log);

  bus.subscribe(() => {
    throw new Error('the listener broke');
  });

  bus.publish('tick');

  expect(log).toHaveBeenCalledExactlyOnceWith(
    'impd: events: a listener failed: the listener broke',
  );
});

test('it stops giving events to a listener once it unsubscribes', () => {
  const bus = createEventBus<string>(() => {});
  const heard: string[] = [];

  const unsubscribe = bus.subscribe((event) => {
    heard.push(event);
  });

  unsubscribe();

  bus.publish('tick');

  expect(heard).toBeEmpty();
});
