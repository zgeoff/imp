import type { TerminalConnection, TerminalSize } from '../components/console/terminal-source';

interface StubTerminalConnectionOptions {
  // how the far end takes a key; by default it accepts and records it
  readonly write?: (data: string) => Promise<void>;
}

// A connection to a program that never ends: the test writes its output
// through `output`, and the connection records the keys and sizes it is sent.
export function buildStubTerminalConnection(options: StubTerminalConnectionOptions = {}) {
  const output = new TransformStream<Uint8Array, Uint8Array>();

  const sent: string[] = [];
  const sizes: TerminalSize[] = [];

  const connection: TerminalConnection = {
    output: output.readable,
    write:
      options.write ??
      ((data) => {
        sent.push(data);

        return Promise.resolve();
      }),
    resize: (size) => {
      sizes.push(size);
    },
    close: () => {},
    ended: new Promise(() => {}),
  };

  return { connection, output: output.writable.getWriter(), sent, sizes };
}
