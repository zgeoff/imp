import { PassThrough } from 'node:stream';

// A terminal on stdin: a stream the test types into with `write`, that says
// it is a TTY and records each raw-mode switch in `modes`, as the
// prompt and the exec client set them.
export function buildStubTerminal() {
  const modes: boolean[] = [];

  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (raw: boolean) => {
      modes.push(raw);
    },
  });

  return { stdin, modes };
}
