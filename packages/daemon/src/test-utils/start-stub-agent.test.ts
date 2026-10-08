import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChildTests } from '@imp/test-utils/run-child-tests';
import { waitFor } from '@imp/test-utils/wait-for';
import { FRAME_TYPES, encodeFrame, encodeJsonFrame } from '../agent-client/frame-codec';
import type { AgentFrame } from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-agent-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it answers the CONNECT line with the handshake reply', async () => {
  const ctx = await setupTest();

  await startStubAgent(join(ctx.dir, 'v.sock'), () => {});

  const client = createConnection(join(ctx.dir, 'v.sock'));

  onTestFinished(() => {
    client.destroy();
  });

  let reply = '';

  client.on('data', (chunk: Buffer) => {
    reply += chunk.toString();
  });

  client.write('CONNECT 1024\n');

  await waitFor(() => {
    if (!reply.endsWith('\n')) {
      throw new Error('no reply yet');
    }
  });

  expect(reply).toBe('OK 1073741824\n');
});

test('it hands each frame to the handler with the request and the frames so far', async () => {
  const ctx = await setupTest();

  const calls: { request: AgentFrame; frames: AgentFrame[] }[] = [];

  await startStubAgent(join(ctx.dir, 'v.sock'), (_socket, request, frames) => {
    calls.push({ request, frames: [...frames] });
  });

  const client = createConnection(join(ctx.dir, 'v.sock'));

  onTestFinished(() => {
    client.destroy();
  });

  client.write('CONNECT 1024\n');

  await new Promise((resolve) => {
    client.once('data', resolve);
  });

  client.write(encodeJsonFrame(FRAME_TYPES.request, { op: 'exec' }));
  client.write(encodeFrame(FRAME_TYPES.stdin, new Uint8Array([7, 8])));

  await waitFor(() => {
    if (calls.length < 2) {
      throw new Error('the frames have not all arrived');
    }
  });

  expect(calls).toStrictEqual([
    {
      request: { type: 1, payload: Buffer.from('{"op":"exec"}') },
      frames: [{ type: 1, payload: Buffer.from('{"op":"exec"}') }],
    },
    {
      request: { type: 1, payload: Buffer.from('{"op":"exec"}') },
      frames: [
        { type: 1, payload: Buffer.from('{"op":"exec"}') },
        { type: 3, payload: Buffer.from([7, 8]) },
      ],
    },
  ]);
});

test('it decodes frames sent in the same chunk as the CONNECT line', async () => {
  const ctx = await setupTest();
  const agent = await startStubAgent(join(ctx.dir, 'v.sock'), () => {});

  const client = createConnection(join(ctx.dir, 'v.sock'));

  onTestFinished(() => {
    client.destroy();
  });

  client.write(
    Buffer.concat([
      Buffer.from('CONNECT 1024\n'),
      encodeJsonFrame(FRAME_TYPES.request, { op: 'ping' }),
    ]),
  );

  await waitFor(() => {
    if (agent.received.length === 0) {
      throw new Error('no frame yet');
    }
  });

  expect(agent.received).toStrictEqual([{ type: 1, payload: Buffer.from('{"op":"ping"}') }]);
});

test('it waits for the rest of a CONNECT line split across chunks', async () => {
  const ctx = await setupTest();
  const agent = await startStubAgent(join(ctx.dir, 'v.sock'), () => {});

  const client = createConnection(join(ctx.dir, 'v.sock'));

  onTestFinished(() => {
    client.destroy();
  });

  let reply = '';

  client.on('data', (chunk: Buffer) => {
    reply += chunk.toString();
  });

  client.write('CONNECT 10');

  await waitFor(() => {
    if (agent.reads === 0) {
      throw new Error('the first chunk has not been read');
    }
  });

  client.write(
    Buffer.concat([Buffer.from('24\n'), encodeJsonFrame(FRAME_TYPES.request, { op: 'ping' })]),
  );

  await waitFor(() => {
    if (agent.received.length === 0) {
      throw new Error('no frame yet');
    }
  });

  expect(reply).toBe('OK 1073741824\n');
  expect(agent.received).toStrictEqual([{ type: 1, payload: Buffer.from('{"op":"ping"}') }]);
});

test('it keeps the frames of every connection in received', async () => {
  const ctx = await setupTest();

  const requests: AgentFrame[] = [];

  const agent = await startStubAgent(join(ctx.dir, 'v.sock'), (_socket, request) => {
    requests.push(request);
  });

  const first = createConnection(join(ctx.dir, 'v.sock'));

  onTestFinished(() => {
    first.destroy();
  });

  const second = createConnection(join(ctx.dir, 'v.sock'));

  onTestFinished(() => {
    second.destroy();
  });

  first.write(
    Buffer.concat([Buffer.from('CONNECT 1024\n'), encodeJsonFrame(FRAME_TYPES.request, { n: 1 })]),
  );

  second.write(
    Buffer.concat([Buffer.from('CONNECT 1024\n'), encodeJsonFrame(FRAME_TYPES.request, { n: 2 })]),
  );

  await waitFor(() => {
    if (agent.received.length < 2) {
      throw new Error('the frames have not all arrived');
    }
  });

  expect(agent.received).toIncludeSameMembers([
    { type: 1, payload: Buffer.from('{"n":1}') },
    { type: 1, payload: Buffer.from('{"n":2}') },
  ]);

  expect(requests).toIncludeSameMembers([
    { type: 1, payload: Buffer.from('{"n":1}') },
    { type: 1, payload: Buffer.from('{"n":2}') },
  ]);
});

test('it hands the handler the socket that replies to the client', async () => {
  const ctx = await setupTest();

  await startStubAgent(join(ctx.dir, 'v.sock'), (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
  });

  const client = createConnection(join(ctx.dir, 'v.sock'));

  onTestFinished(() => {
    client.destroy();
  });

  let reply = Buffer.alloc(0);

  client.on('data', (chunk: Buffer) => {
    reply = Buffer.concat([reply, chunk]);
  });

  client.write(
    Buffer.concat([Buffer.from('CONNECT 1024\n'), encodeJsonFrame(FRAME_TYPES.request, {})]),
  );

  await waitFor(() => {
    if (reply.byteLength < 14 + 16) {
      throw new Error('no response frame yet');
    }
  });

  expect(reply).toStrictEqual(
    Buffer.concat([
      Buffer.from('OK 1073741824\n'),
      encodeJsonFrame(FRAME_TYPES.response, { ok: true }),
    ]),
  );
});

test('it stops accepting connections once closed', async () => {
  const ctx = await setupTest();
  const agent = await startStubAgent(join(ctx.dir, 'v.sock'), () => {});

  agent.close();

  const client = createConnection(join(ctx.dir, 'v.sock'));

  onTestFinished(() => {
    client.destroy();
  });

  const failed = new Promise((resolve) => {
    client.once('error', resolve);
  });

  expect(failed).resolves.toMatchObject({ code: expect.toBeOneOf(['ENOENT', 'ECONNREFUSED']) });
});

test('it closes when the test finishes', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    [
      "import { expect, test } from 'bun:test';",
      "import { createConnection } from 'node:net';",
      `import { startStubAgent } from ${JSON.stringify(join(import.meta.dir, 'start-stub-agent.ts'))};`,
      `const path = ${JSON.stringify(join(ctx.dir, 'v.sock'))};`,
      "test('it starts', async () => { await startStubAgent(path, () => {}); });",
      "test('it finds it closed', () => {",
      '  const client = createConnection(path);',
      "  const failed = new Promise((resolve) => { client.once('error', resolve); });",
      '  expect(failed).resolves.toMatchObject({ code: expect.stringMatching(/ENOENT|ECONNREFUSED/) });',
      '});',
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});

test('it closes when the stack it was given is released', async () => {
  const ctx = await setupTest();

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  await startStubAgent(join(ctx.dir, 'v.sock'), () => {}, { stack });

  await stack.disposeAsync();

  const client = createConnection(join(ctx.dir, 'v.sock'));

  onTestFinished(() => {
    client.destroy();
  });

  const failed = new Promise((resolve) => {
    client.once('error', resolve);
  });

  expect(failed).resolves.toMatchObject({ code: expect.toBeOneOf(['ENOENT', 'ECONNREFUSED']) });
});

test('it leaves its close to the stack it was given, not the test’s end', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    [
      "import { expect, test } from 'bun:test';",
      "import { createConnection } from 'node:net';",
      `import { startStubAgent } from ${JSON.stringify(join(import.meta.dir, 'start-stub-agent.ts'))};`,
      `const path = ${JSON.stringify(join(ctx.dir, 'v.sock'))};`,
      'const stack = new AsyncDisposableStack();',
      "test('it starts', async () => { await startStubAgent(path, () => {}, { stack }); });",
      "test('it finds it open', async () => {",
      '  const client = createConnection(path);',
      "  const connected = new Promise((resolve) => { client.once('connect', resolve); });",
      '  await expect(connected).resolves.toBeUndefined();',
      '  client.destroy();',
      '  await stack.disposeAsync();',
      '});',
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});
