import { expect, test } from 'bun:test';
import { makeTraceLines } from './make-trace-lines';

test('it prints a step as it starts, its output line by line, then its end', () => {
  const lines: string[] = [];
  const steps: string[] = [];

  const readTrace = makeTraceLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: (step) => {
      steps.push(step);
    },
  });

  const encoder = new TextEncoder();

  const vertex = {
    digest: 'sha256:aa',
    name: '[2/3] RUN make all',
    cached: false,
    error: '',
  };

  readTrace({ vertexes: [{ ...vertex, started: true, completed: false }], logs: [] });

  readTrace({
    vertexes: [],
    logs: [{ vertex: 'sha256:aa', msg: encoder.encode('cc -o widget main.c\nlinking') }],
  });

  readTrace({ vertexes: [], logs: [{ vertex: 'sha256:aa', msg: encoder.encode(' widget\n') }] });
  readTrace({ vertexes: [{ ...vertex, started: true, completed: true }], logs: [] });

  expect(lines).toStrictEqual([
    '#1 [2/3] RUN make all',
    '#1 cc -o widget main.c',
    '#1 linking widget',
    '#1 DONE',
  ]);

  expect(steps).toStrictEqual(['[2/3] RUN make all']);
});

test('it prints the output of a message before the end the same message reports', () => {
  const lines: string[] = [];

  const readTrace = makeTraceLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  readTrace({
    vertexes: [
      {
        digest: 'sha256:bb',
        name: '[1/1] RUN false',
        cached: false,
        started: true,
        completed: true,
        error: 'exit code: 1',
      },
    ],
    logs: [{ vertex: 'sha256:bb', msg: new TextEncoder().encode('about to fail') }],
  });

  expect(lines).toStrictEqual(['#1 [1/1] RUN false', '#1 about to fail', '#1 ERROR: exit code: 1']);
});

test('it numbers vertexes in the order they start and announces a restarted one once', () => {
  const lines: string[] = [];

  const readTrace = makeTraceLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  const from = { digest: 'sha256:cc', name: '[1/2] FROM alpine', error: '' };
  const cached = { digest: 'sha256:dd', name: '[2/2] COPY . /app', error: '' };

  readTrace({
    vertexes: [
      { ...from, cached: false, started: true, completed: true },
      { ...from, cached: false, started: true, completed: false },
      { ...from, cached: false, started: true, completed: true },
      { ...cached, cached: true, started: false, completed: false },
    ],
    logs: [],
  });

  expect(lines).toStrictEqual([
    '#1 [1/2] FROM alpine',
    '#2 [2/2] COPY . /app',
    '#1 DONE',
    '#2 CACHED',
  ]);
});

test('it passes over a vertex that has not started and output of a vertex it never saw', () => {
  const lines: string[] = [];

  const readTrace = makeTraceLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  readTrace({
    vertexes: [
      {
        digest: 'sha256:ee',
        name: '[3/3] RUN make install',
        cached: false,
        started: false,
        completed: false,
        error: '',
      },
    ],
    logs: [{ vertex: 'sha256:ff', msg: new TextEncoder().encode('stray\n') }],
  });

  expect(lines).toStrictEqual([]);
});

test('it reads a character a vertex split across two log chunks, beside another vertex', () => {
  const lines: string[] = [];

  const readTrace = makeTraceLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  const bytes = new TextEncoder().encode('café ready\n');

  const vertex = { cached: false, started: true, completed: false, error: '' };

  readTrace({
    vertexes: [
      { ...vertex, digest: 'sha256:aa', name: '[2/3] RUN ./brew' },
      { ...vertex, digest: 'sha256:bb', name: '[builder 2/2] RUN make' },
    ],
    logs: [
      { vertex: 'sha256:aa', msg: bytes.slice(0, 4) },
      { vertex: 'sha256:bb', msg: new TextEncoder().encode('ok\n') },
      { vertex: 'sha256:aa', msg: bytes.slice(4) },
    ],
  });

  expect(lines).toStrictEqual([
    '#1 [2/3] RUN ./brew',
    '#2 [builder 2/2] RUN make',
    '#2 ok',
    '#1 café ready',
  ]);
});

test('it sends output with no newline in pieces as it grows past what a log event holds', () => {
  const lines: string[] = [];

  const readTrace = makeTraceLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  readTrace({
    vertexes: [
      {
        digest: 'sha256:aa',
        name: '[1/1] RUN ./progress-bar',
        cached: false,
        started: true,
        completed: false,
        error: '',
      },
    ],
    logs: [{ vertex: 'sha256:aa', msg: new TextEncoder().encode('z'.repeat(10_000)) }],
  });

  expect(lines).toStrictEqual(['#1 [1/1] RUN ./progress-bar', `#1 ${'z'.repeat(8128)}`]);
});

test('it cuts a line longer than a log event holds', () => {
  const lines: string[] = [];

  const readTrace = makeTraceLines({
    emitLog: (line) => {
      lines.push(line);
    },
    setStep: () => {},
  });

  readTrace({
    vertexes: [
      {
        digest: 'sha256:aa',
        name: '[1/1] RUN cat big.txt',
        cached: false,
        started: true,
        completed: false,
        error: '',
      },
    ],
    logs: [{ vertex: 'sha256:aa', msg: new TextEncoder().encode(`${'y'.repeat(9000)}\n`) }],
  });

  expect(lines[1]).toHaveLength(8192);
});
