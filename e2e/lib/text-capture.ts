export interface TextCapture {
  // what the stream sent so far
  readonly read: () => string;

  // settles once the stream ends
  readonly done: Promise<void>;
}

// Collects a child's output stream as text while the test goes on, such as
// the lines `imp proxy` or `imp events` print.
export function startTextCapture(stream: ReadableStream<Uint8Array>): TextCapture {
  const decoder = new TextDecoder();

  let text = '';

  const done = (async () => {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
    }

    text += decoder.decode();
  })();

  return { read: () => text, done };
}
