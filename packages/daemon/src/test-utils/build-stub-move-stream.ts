export interface StubMoveStreamOptions {
  // runs once the last byte is out, before the stream ends, as a peer's
  // stream that stays open after `zfs recv` committed it
  readonly onEnd?: () => Promise<void>;

  // ends the stream with this error after its last byte instead of closing
  readonly failAtEnd?: Error;
}

// A move step's stream as a peer sends it: the bytes of `source`, then
// whatever the peer does at the end
export function buildStubMoveStream(
  source: ReadableStream<Uint8Array>,
  options: Readonly<StubMoveStreamOptions> = {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const onEnd = options.onEnd ?? (() => Promise.resolve());

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const read = await reader.read();

      if (!read.done) {
        controller.enqueue(read.value);

        return;
      }

      await onEnd();

      if (options.failAtEnd === undefined) {
        controller.close();
      } else {
        controller.error(options.failAtEnd);
      }
    },
  });
}
