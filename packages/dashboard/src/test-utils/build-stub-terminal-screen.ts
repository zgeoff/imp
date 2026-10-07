import type { TerminalScreen } from '../components/console/setup-terminal-bridge';
import type { TerminalSize } from '../components/console/terminal-source';

// An xterm.js screen: it records what is written to it as text, lets the test
// type keys and resize it, and records which listeners were disposed.
export function buildStubTerminalScreen() {
  const written: string[] = [];
  const disposed: string[] = [];
  const listeners: { data?: (data: string) => void; resize?: (size: TerminalSize) => void } = {};

  const screen: TerminalScreen = {
    write: (data) => {
      written.push(new TextDecoder().decode(data));
    },
    onData: (listener) => {
      listeners.data = listener;

      return {
        dispose: () => {
          delete listeners.data;
          disposed.push('data');
        },
      };
    },
    onResize: (listener) => {
      listeners.resize = listener;

      return {
        dispose: () => {
          delete listeners.resize;
          disposed.push('resize');
        },
      };
    },
  };

  // as a user types: throws when nothing listens for keys
  const emitKeys = (data: string): void => {
    if (listeners.data === undefined) {
      throw new Error('nothing listens for keys');
    }

    listeners.data(data);
  };

  // as the window resizes: throws when nothing listens for sizes
  const emitResize = (size: TerminalSize): void => {
    if (listeners.resize === undefined) {
      throw new Error('nothing listens for sizes');
    }

    listeners.resize(size);
  };

  return { screen, written, disposed, emitKeys, emitResize };
}
