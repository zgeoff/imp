// What a terminal view connects to. A console (a fresh login shell) is one
// source; a detachable session (#13) will be another, whose open attaches,
// replays the screen and then goes live. The view does not tell them apart.
export interface TerminalSource {
  // what the view shows while it connects and after the end, e.g. "console"
  readonly label: string;
  readonly open: (size: TerminalSize, signal: AbortSignal) => Promise<TerminalConnection>;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalConnection {
  // everything the far end prints, as the terminal should show it
  readonly output: ReadableStream<Uint8Array>;
  readonly write: (data: string) => Promise<void>;
  readonly resize: (size: TerminalSize) => void;
  readonly close: () => void;

  // settles once, when the program exits or the connection drops
  readonly ended: Promise<TerminalEnd>;
}

export type TerminalEnd =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'error'; readonly message: string };
