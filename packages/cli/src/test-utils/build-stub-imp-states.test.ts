import { expect, test } from 'bun:test';
import { buildStubImpStates } from './build-stub-imp-states';

test('it hands a watch the added states in order', async () => {
  const states = buildStubImpStates();
  const watch = states.watchImp(null, 'box', new AbortController().signal);
  const iterator = watch[Symbol.asyncIterator]();

  states.add('running');
  states.add('sleeping');

  const read = [await iterator.next(), await iterator.next()];

  expect(read).toStrictEqual([
    { done: false, value: 'running' },
    { done: false, value: 'sleeping' },
  ]);
});

test('it holds a read until a state is added', async () => {
  const states = buildStubImpStates();
  const watch = states.watchImp(null, 'box', new AbortController().signal);
  const iterator = watch[Symbol.asyncIterator]();
  const reading = iterator.next();

  states.add('running');

  const read = await reading;

  expect(read).toStrictEqual({ done: false, value: 'running' });
});

test('it counts the watches and the reads they ask for', async () => {
  const states = buildStubImpStates();
  const watch = states.watchImp(null, 'box', new AbortController().signal);
  const iterator = watch[Symbol.asyncIterator]();

  states.add('running');

  await iterator.next();

  void iterator.next();
  expect(states.watches).toBe(1);
  expect(states.reads).toBe(2);
});

test('it ends a watch whose signal aborts, and counts the abort', async () => {
  const states = buildStubImpStates();

  const controller = new AbortController();

  const watch = states.watchImp(null, 'box', controller.signal);
  const iterator = watch[Symbol.asyncIterator]();
  const reading = iterator.next();

  controller.abort();

  const read = await reading;

  expect(read).toStrictEqual({ done: true, value: undefined });
  expect(states.aborts).toBe(1);
});

test('it ends a watch once the queue is read after the stream ends', async () => {
  const states = buildStubImpStates();
  const watch = states.watchImp(null, 'box', new AbortController().signal);
  const iterator = watch[Symbol.asyncIterator]();

  states.add('sleeping');
  states.end();

  const read = [await iterator.next(), await iterator.next()];

  expect(read).toStrictEqual([
    { done: false, value: 'sleeping' },
    { done: true, value: undefined },
  ]);
});
