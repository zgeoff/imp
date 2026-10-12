import { expect, test } from 'bun:test';
import { buildStubAnswerQueue } from './build-stub-answer-queue';

test('it hands out the answers in order, null answers included', () => {
  const answers = buildStubAnswerQueue(['127.0.0.2', null, '127.0.0.3']);

  expect([answers.next(), answers.next(), answers.next()]).toStrictEqual([
    '127.0.0.2',
    null,
    '127.0.0.3',
  ]);
});

test('it counts the answers not handed out yet', () => {
  const answers = buildStubAnswerQueue([1, 2, 3]);

  answers.next();

  expect(answers.left).toBe(2);
});

test('it throws on a call past the last answer', () => {
  const answers = buildStubAnswerQueue(['only']);

  answers.next();

  expect(() => answers.next()).toThrowWithMessage(
    Error,
    'the answer queue is empty after 1 answers',
  );
});

test('it keeps its own copy, so a change to the given list changes no answer', () => {
  const list = ['first', 'second'];
  const answers = buildStubAnswerQueue(list);

  list.length = 0;

  expect(answers.next()).toBe('first');
});
