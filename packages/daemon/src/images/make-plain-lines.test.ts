import { expect, test } from 'bun:test';
import { makePlainLines } from './make-plain-lines';

test('it sends each line of plain progress as it completes, across chunks', () => {
  const lines: string[] = [];

  const readChunk = makePlainLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  const encoder = new TextEncoder();

  readChunk(encoder.encode('#5 [2/3] RUN make all\n#5 0.21'));
  readChunk(encoder.encode('5 cc -o widget main.c\n#5 DONE 0.4s\n#6 export'));

  expect(lines).toStrictEqual([
    '#5 [2/3] RUN make all',
    '#5 0.215 cc -o widget main.c',
    '#5 DONE 0.4s',
  ]);
});

test('it follows the step that runs, back to the one still running when another ends', () => {
  const steps: string[] = [];

  const readChunk = makePlainLines({
    emitLog: () => {},
    setStep: (step) => {
      steps.push(step);
    },
  });

  readChunk(
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

  const readChunk = makePlainLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  readChunk(new TextEncoder().encode('z'.repeat(5000)));
  readChunk(new TextEncoder().encode('z'.repeat(5000)));

  expect(lines).toStrictEqual(['z'.repeat(8192)]);
});

test('it reads a character split across two chunks', () => {
  const lines: string[] = [];

  const readChunk = makePlainLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  const bytes = new TextEncoder().encode('#5 0.1 café\n');

  readChunk(bytes.slice(0, 10));
  readChunk(bytes.slice(10));

  expect(lines).toStrictEqual(['#5 0.1 café']);
});
