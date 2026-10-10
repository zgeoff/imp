import type { DialEvent, DialStream } from '../agent-client/dial-stream';

// what the guest side sends next: an event, the end of the stream, or a
// broken agent connection
type StubDialItem =
  | { readonly kind: 'event'; readonly event: DialEvent }
  | { readonly kind: 'end' }
  | { readonly kind: 'fail'; readonly error: Error };

interface StubDialQueue {
  readonly items: StubDialItem[];
  wake: (() => void) | null;
}

const decoder = new TextDecoder();

// A relay to a guest connection, as the agent's dial and accept open it: it
// records impd's writes and closes, and the test sends the guest's side. A
// held `drained` stands for a guest that has not taken the bytes yet.
export function buildStubDialStream() {
  const queue: StubDialQueue = { items: [], wake: null };
  const drain = { gate: Promise.resolve() };

  const state = {
    // each write, decoded as text
    written: [] as string[],
    isEnded: false,
    isClosed: false,

    // how many times impd waited for the guest to take its bytes
    drainWaits: 0,
  };

  const sendItem = (item: StubDialItem): void => {
    queue.items.push(item);
    queue.wake?.();
  };

  // the next item, once the test sent one
  const readNext = async (): Promise<StubDialItem> => {
    while (queue.items.length === 0) {
      await new Promise<void>((resolve) => {
        queue.wake = resolve;
      });
    }

    return queue.items.shift() ?? { kind: 'end' };
  };

  const stream: DialStream = {
    write: (data) => {
      state.written.push(decoder.decode(data));
    },
    drained: () => {
      state.drainWaits += 1;

      return drain.gate;
    },
    end: () => {
      state.isEnded = true;
    },
    events: () => readDialEvents(readNext),

    // the agent's close ends the events
    close: () => {
      state.isClosed = true;

      sendItem({ kind: 'end' });
    },
  };

  return {
    stream,
    state,

    // the guest sends bytes, or its eof
    emit: (event: DialEvent): void => {
      sendItem({ kind: 'event', event });
    },

    // the relay ends with no more events, as the agent ends it
    end: (): void => {
      sendItem({ kind: 'end' });
    },

    // the agent connection breaks: the events throw `error`
    fail: (error: Error): void => {
      sendItem({ kind: 'fail', error });
    },

    // how many sent items impd has not read yet
    countUnread: (): number => queue.items.length,

    // holds `drained` until the returned release runs
    holdDrain: (): (() => void) => {
      const held = Promise.withResolvers<void>();

      drain.gate = held.promise;

      return held.resolve;
    },
  };
}

async function* readDialEvents(
  readNext: () => Promise<StubDialItem>,
): AsyncGenerator<DialEvent, void, undefined> {
  for (;;) {
    const item = await readNext();

    if (item.kind === 'end') {
      return;
    }

    if (item.kind === 'fail') {
      throw item.error;
    }

    yield item.event;
  }
}
