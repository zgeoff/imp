// A dependency's answers in the order a test scripts them: `next()` hands out
// the next one and throws once none is left, so an extra call fails the test.
// `left` counts the answers not handed out yet.
export function buildStubAnswerQueue<T>(answers: readonly T[]) {
  const queue = [...answers];

  return {
    next: (): T => {
      if (queue.length === 0) {
        throw new Error(`the answer queue is empty after ${answers.length} answers`);
      }

      return queue.shift() as T;
    },

    get left(): number {
      return queue.length;
    },
  };
}
