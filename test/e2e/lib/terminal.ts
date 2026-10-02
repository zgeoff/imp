import { join } from 'node:path';
import { readImpEnv } from './imp-cli';
import { REPO_ROOT } from './instance';
import { waitFor } from './wait-for';

export interface Terminal {
  // raw bytes, as keys typed at the terminal
  readonly type: (text: string) => void;

  // as a user who resizes the terminal window
  readonly resize: (cols: number, rows: number) => void;

  // resolves once the terminal has shown `text`, counting from `since`
  readonly waitForText: (text: string, since?: number) => Promise<void>;

  // what the terminal showed so far, without carriage returns
  readonly readOutput: () => string;
  readonly exited: Promise<number>;
}

const DEFAULT_SIZE = { cols: 80, rows: 24 } as const;

// Runs `imp ARGS...` on a pseudo-terminal of the given size, as a user at a
// terminal would.
export async function openTerminal(
  args: readonly string[],
  size?: Readonly<{ cols: number; rows: number }>,
): Promise<Terminal> {
  const impEnv = await readImpEnv();

  return openCommandTerminal([join(REPO_ROOT, 'scripts', 'imp'), ...args], impEnv, size);
}

// Runs any command on a pseudo-terminal, such as `ssh` into an imp.
export function openCommandTerminal(
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
  size?: Readonly<{ cols: number; rows: number }>,
): Terminal {
  const decoder = new TextDecoder();

  const shown = { text: '' };

  const proc = Bun.spawn([...argv], {
    env: { ...process.env, ...env },
    terminal: {
      ...(size ?? DEFAULT_SIZE),
      data: (_terminal, data) => {
        shown.text += decoder.decode(data, { stream: true });
      },
    },
  });

  const readOutput = (): string => shown.text.replaceAll('\r', '');

  const exited = (async () => {
    const code = await proc.exited;

    proc.terminal?.close();

    return code;
  })();

  return {
    type: (text) => {
      proc.terminal?.write(text);
    },
    resize: (cols, rows) => {
      proc.terminal?.resize(cols, rows);
    },
    waitForText: (text, since = 0) =>
      waitFor(
        `the terminal to show ${JSON.stringify(text)}`,
        () => {
          if (!readOutput().slice(since).includes(text)) {
            throw new Error(`not yet; last: ${JSON.stringify(readOutput().slice(-200))}`);
          }
        },
        { intervalMs: 50, timeoutMs: 30_000 },
      ),
    readOutput,
    exited,
  };
}
