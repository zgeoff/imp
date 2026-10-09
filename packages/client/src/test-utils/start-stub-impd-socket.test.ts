import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChildTests } from '@imp/test-utils/run-child-tests';
import { waitFor } from '@imp/test-utils/wait-for';
import { startStubImpdSocket } from './start-stub-impd-socket';

// a directory for a child test run
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-impd-socket-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it answers the first message with the frames it was given, in order', async () => {
  const stub = startStubImpdSocket(['one', 'two']);

  const socket = new WebSocket(stub.url.replace('http', 'ws'));

  onTestFinished(() => {
    socket.close();
  });

  const answers: string[] = [];

  socket.addEventListener('message', (event) => {
    answers.push(String(event.data));
  });

  socket.addEventListener('open', () => {
    socket.send('hello');
  });

  await waitFor(() => {
    expect(answers).toStrictEqual(['one', 'two']);
  });
});

test('it records every message and answers only the first', async () => {
  const stub = startStubImpdSocket(['one']);

  const socket = new WebSocket(stub.url.replace('http', 'ws'));

  onTestFinished(() => {
    socket.close();
  });

  const answers: string[] = [];

  socket.addEventListener('message', (event) => {
    answers.push(String(event.data));
  });

  socket.addEventListener('open', () => {
    socket.send('first');
    socket.send('second');
  });

  await waitFor(() => {
    expect(stub.received).toStrictEqual(['first', 'second']);
  });

  expect(answers).toStrictEqual(['one']);
});

test('it refuses a request that is not a socket upgrade with 400', async () => {
  const stub = startStubImpdSocket([]);

  const response = await fetch(stub.url);

  expect(response.status).toBe(400);
});

test('it stops when the test finishes', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    [
      "import { expect, test } from 'bun:test';",
      `import { startStubImpdSocket } from ${JSON.stringify(join(import.meta.dir, 'start-stub-impd-socket.ts'))};`,
      'const seen = { url: "" };',
      "test('it starts', () => { seen.url = startStubImpdSocket([]).url; });",
      "test('it finds it stopped', () => {",
      '  expect(fetch(seen.url)).rejects.toMatchObject({ code: "ConnectionRefused" });',
      '});',
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});
