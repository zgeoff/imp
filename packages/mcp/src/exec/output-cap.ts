// One output stream, held to `maxBytes`: the first `headBytes` and the last
// bytes up to the cap. The middle is dropped, where the least is lost: a
// build's first error is near the head, its summary near the tail.
export interface CappedOutput {
  readonly head: Uint8Array;
  readonly tail: Uint8Array;
  readonly droppedBytes: number;
}

export interface OutputCollector {
  readonly push: (chunk: Uint8Array) => void;
  readonly finish: () => CappedOutput;
}

export function createOutputCollector(maxBytes: number, headBytes: number): OutputCollector {
  const headLimit = Math.min(headBytes, maxBytes);
  const tailLimit = maxBytes - headLimit;
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  const counts = { head: 0, tail: 0, dropped: 0 };

  const writeTail = (chunk: Uint8Array): void => {
    if (tailLimit === 0) {
      counts.dropped += chunk.byteLength;

      return;
    }

    tail.push(chunk);

    counts.tail += chunk.byteLength;

    // drop whole chunks off the front, then trim the first one
    while (counts.tail > tailLimit) {
      const [first] = tail;

      if (first === undefined) {
        break;
      }

      const excess = counts.tail - tailLimit;

      if (first.byteLength <= excess) {
        tail.shift();

        counts.tail -= first.byteLength;
        counts.dropped += first.byteLength;
      } else {
        tail[0] = first.subarray(excess);
        counts.tail -= excess;
        counts.dropped += excess;
      }
    }
  };

  return {
    push: (chunk) => {
      const room = headLimit - counts.head;

      if (room > 0) {
        const taken = chunk.subarray(0, room);

        head.push(taken);

        counts.head += taken.byteLength;

        if (taken.byteLength === chunk.byteLength) {
          return;
        }

        writeTail(chunk.subarray(room));

        return;
      }

      writeTail(chunk);
    },
    finish: () => ({
      head: mergeBytes(head),
      tail: mergeBytes(tail),
      droppedBytes: counts.dropped,
    }),
  };
}

function mergeBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

  const joined = new Uint8Array(total);

  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);

    offset += chunk.byteLength;
  }

  return joined;
}

// The text an agent reads: invalid UTF-8 becomes U+FFFD, and a marker says
// where bytes were dropped and how many.
export function formatCappedText(output: Readonly<CappedOutput>): string {
  const decoder = new TextDecoder();

  const head = decoder.decode(output.head);
  const tail = decoder.decode(output.tail);

  if (output.droppedBytes === 0) {
    return head + tail;
  }

  return `${head}\n[... ${String(output.droppedBytes)} bytes dropped ...]\n${tail}`;
}
