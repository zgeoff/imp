import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRejection } from '../read-rejection';
import { startStubAgent } from '../test-utils/start-stub-agent';
import type { StubAgentHandler } from '../test-utils/start-stub-agent';
import { openDialStream } from './dial-stream';
import type { DialEvent, DialStream } from './dial-stream';
import { FRAME_TYPES, decodeJsonPayload, encodeFrame, encodeJsonFrame } from './frame-codec';

const TARGET = { network: 'tcp', address: '127.0.0.1:8080' } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function setupFakeVsock(agent: StubAgentHandler) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-dial-'));
  const path = join(dir, 'vsock.sock');

  const fake = await startStubAgent(path, agent);

  return {
    path,
    received: fake.received,
    [Symbol.dispose]() {
      fake.close();

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function collectEvents(stream: DialStream): Promise<string[]> {
  const collected: string[] = [];

  for await (const event of stream.events()) {
    collected.push(formatEvent(event));
  }

  return collected;
}

function formatEvent(event: DialEvent): string {
  return event.type === 'eof' ? '<eof>' : decoder.decode(event.data);
}

test('a dial relays both ways, with a half-close each way', async () => {
  using vsock = await setupFakeVsock((socket, request, frames) => {
    const last = frames.at(-1);

    if (frames.length === 1) {
      expect(decodeJsonPayload(request)).toEqual({ op: 'dial', ...TARGET });

      socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
    } else if (last?.type === FRAME_TYPES.stdinEof) {
      // the target answers once the request is whole, then closes its side
      const asked = frames
        .filter((frame) => frame.type === FRAME_TYPES.stdin)
        .map((frame) => decoder.decode(frame.payload))
        .join('');

      socket.write(encodeFrame(FRAME_TYPES.stdout, encoder.encode(`got ${asked}`)));
      socket.end(encodeFrame(FRAME_TYPES.stdoutEof));
    }
  });

  const stream = await openDialStream(vsock.path, TARGET);

  stream.write(encoder.encode('hello'));

  await stream.drained();

  stream.end();

  const events = await collectEvents(stream);

  expect(events).toEqual(['got hello', '<eof>']);
});

test('a refused connect rejects with DIAL_FAILED', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'DIAL_FAILED', message: 'dial tcp 127.0.0.1:8080: connection refused' },
      }),
    );
  });

  const failure = await readRejection(openDialStream(vsock.path, TARGET));

  expect(failure).toMatchObject({ code: 'DIAL_FAILED' });
});

test('an agent from before dial gets AGENT_OUTDATED', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op dial' },
      }),
    );
  });

  const failure = await readRejection(openDialStream(vsock.path, TARGET));

  expect(failure).toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('a target that resets ends the events without an eof', async () => {
  using vsock = await setupFakeVsock((socket, _request, frames) => {
    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
      socket.end(encodeFrame(FRAME_TYPES.stdout, encoder.encode('partial')));
    }
  });

  const stream = await openDialStream(vsock.path, TARGET);
  const events = await collectEvents(stream);

  expect(events).toEqual(['partial']);
});
