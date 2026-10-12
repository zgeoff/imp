// A dependency's answers in the order a test scripts them: `next()` hands out
// the next one and throws once none is left, so an extra call fails the test.
// `left` counts the answers not handed out yet.
export function buildStubAnswerQueue<T>(answers: readonly T[]) {
  const queue = [...answers][Symbol.iterator]();
  let left = answers.length;

  return {
    next: (): T => {
      const answer = queue.next();

      if (answer.done === true) {
        throw new Error(`the answer queue is empty after ${answers.length} answers`);
      }

      left -= 1;

      return answer.value;
    },

    get left(): number {
      return left;
    },
  };
}
