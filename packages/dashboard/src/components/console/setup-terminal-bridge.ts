import type { TerminalConnection, TerminalSize } from './terminal-source';

interface Disposable {
  readonly dispose: () => void;
}

// the part of an xterm.js Terminal this needs, so tests can stand in for it
export interface TerminalScreen {
  readonly write: (data: Uint8Array) => void;
  readonly onData: (listener: (data: string) => void) => Disposable;
  readonly onResize: (listener: (size: TerminalSize) => void) => Disposable;
}

// Wires a screen to a connection: output to the screen, keys and size to
// the far end. The returned function unwires it and stops reading.
export function setupTerminalBridge(
  screen: TerminalScreen,
  connection: TerminalConnection,
): () => void {
  const reader = connection.output.getReader();

  const readToScreen = async (): Promise<void> => {
    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) {
          return;
        }

        screen.write(chunk.value);
      }
    } catch {
      // the connection's `ended` says why the output stopped
    }
  };

  const sendKey = async (data: string): Promise<void> => {
    try {
      await connection.write(data);
    } catch {
      // a key after the end goes nowhere; `ended` reports the end
    }
  };

  const stopReading = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // already ended
    }
  };

  void readToScreen();

  const listeners = [
    screen.onData((data) => {
      void sendKey(data);
    }),
    screen.onResize((size) => {
      connection.resize(size);
    }),
  ];

  return () => {
    for (const listener of listeners) {
      listener.dispose();
    }

    void stopReading();
  };
}
