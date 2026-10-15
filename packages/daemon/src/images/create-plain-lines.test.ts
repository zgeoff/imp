import { expect, test } from 'bun:test';
import { createPlainLines } from './create-plain-lines';

test('it sends each line of plain progress as it completes, across chunks', () => {
  const lines: string[] = [];

  const plain = createPlainLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  const encoder = new TextEncoder();

  plain.readChunk(encoder.encode('#5 [2/3] RUN make all\n#5 0.21'));
  plain.readChunk(encoder.encode('5 cc -o widget main.c\n#5 DONE 0.4s\n#6 export'));

  expect(lines).toStrictEqual([
    '#5 [2/3] RUN make all',
    '#5 0.215 cc -o widget main.c',
    '#5 DONE 0.4s',
  ]);
});

test('it sends the last line, and follows its step, when the output ends without a newline', () => {
  const lines: string[] = [];
  const steps: string[] = [];

  const plain = createPlainLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: (step) => {
      steps.push(step);
    },
  });

  plain.readChunk(new TextEncoder().encode('#5 DONE 0.4s\n#6 [3/3] COPY notes.txt /srv'));
  plain.flush();
  plain.flush();

  expect(lines).toStrictEqual(['#5 DONE 0.4s', '#6 [3/3] COPY notes.txt /srv']);
  expect(steps).toStrictEqual(['[3/3] COPY notes.txt /srv']);
});

test('it follows the step that runs, back to the one still running when another ends', () => {
  const steps: string[] = [];

  const plain = createPlainLines({
    emitLog: () => {},
    setStep: (step) => {
      steps.push(step);
    },
  });

  plain.readChunk(
    new TextEncoder().encode(
      [
        '#1 [internal] load build definition from Dockerfile',
        '#4 [builder 2/4] RUN make all',
        '#7 [stage-1 2/3] COPY etc /etc',
        '#7 DONE 0.1s',
        '#4 0.512 cc -o widget main.c',
        '',
      ].join('\n'),
    ),
  );

  expect(steps).toStrictEqual([
    '[builder 2/4] RUN make all',
    '[stage-1 2/3] COPY etc /etc',
    '[builder 2/4] RUN make all',
  ]);
});

test('it sends output with no newline in pieces as it grows past what a log event holds', () => {
  const lines: string[] = [];

  const plain = createPlainLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  plain.readChunk(new TextEncoder().encode('z'.repeat(5000)));
  plain.readChunk(new TextEncoder().encode('z'.repeat(5000)));

  expect(lines).toStrictEqual(['z'.repeat(8192)]);
});

test('it reads a character split across two chunks', () => {
  const lines: string[] = [];

  const plain = createPlainLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  const bytes = new TextEncoder().encode('#5 0.1 café\n');

  plain.readChunk(bytes.slice(0, 10));
  plain.readChunk(bytes.slice(10));

  expect(lines).toStrictEqual(['#5 0.1 café']);
});
