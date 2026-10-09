// Reads `source` to its end in the background, keeping each item as it
// comes. `ended` settles once the source ends: with null when it ended on
// its own, or with what it threw, such as the abort of the call it reads.
export function readInBackground<T>(source: Readonly<AsyncIterable<T>>) {
  const items: T[] = [];

  const read = async (): Promise<unknown> => {
    try {
      for await (const item of source) {
        items.push(item);
      }

      return null;
    } catch (error) {
      return error;
    }
  };

  return { items, ended: read() };
}
