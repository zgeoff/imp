import { expect, test } from 'bun:test';
import { createLogBudget } from './create-log-budget';

test('it admits a line while the queue has room', () => {
  const logs = createLogBudget();

  expect(logs.admit('#4 cc -o widget main.c', true)).toStrictEqual(['#4 cc -o widget main.c']);
});

test('it drops lines while the queue is full, and counts them before the next line it admits', () => {
  const logs = createLogBudget();

  logs.admit('#4 cc -o parser.o parser.c', false);
  logs.admit('#4 cc -o lexer.o lexer.c', false);

  expect(logs.admit('#4 ld -o widget', true)).toStrictEqual([
    'imp: 2 lines of build output dropped: the client read them more slowly than the build wrote them',
    '#4 ld -o widget',
  ]);
});

test('it counts the lines dropped at the end once, and nothing when it dropped none', () => {
  const logs = createLogBudget();

  logs.admit('#4 cc -o parser.o parser.c', false);

  const first = logs.drain();
  const second = logs.drain();

  expect(first).toStrictEqual([
    'imp: 1 line of build output dropped: the client read them more slowly than the build wrote them',
  ]);

  expect(second).toStrictEqual([]);
});
