// The text a reader hands on until none comes for `quietMs` or the stream
// ends: what a stream has queued. The read still pending then takes the next
// chunk, so the reader is spent.
export async function readQueuedText(
  reader: ReadableStreamDefaultReader<string>,
  quietMs: number,
): Promise<string> {
  const parts: string[] = [];

  for (;;) {
    const quiet = Promise.withResolvers<null>();

    const timer = setTimeout(() => {
      quiet.resolve(null);
    }, quietMs);

    const chunk = await Promise.race([reader.read(), quiet.promise]);

    clearTimeout(timer);

    if (chunk === null || chunk.done) {
      return parts.join('');
    }

    parts.push(chunk.value);
  }
}
