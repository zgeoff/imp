import { expect, test } from 'bun:test';
import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_WINDOW_BYTES,
} from '@imp/api';
import * as z from 'zod';
import { AgentError } from '../agent-client/agent-connection';
import type { DialEvent, DialStream, DialTarget } from '../agent-client/dial-stream';
import { createTunnelLimits, createTunnelSession } from './tunnel-session';
import type { TunnelLimits } from './tunnel-session';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// a dial the test drives: it records what the tunnel wrote, and the test
// emits the guest's side
function createFakeDial() {
  const events: (DialEvent | null)[] = [];
  const waiter: { wake: (() => void) | null } = { wake: null };
  const state = { written: [] as string[], ended: false, closed: false };
  const drain = { gate: Promise.withResolvers<void>() };

  drain.gate.resolve();

  const emit = (event: DialEvent | null): void => {
    events.push(event);
    waiter.wake?.();
  };

  const source = {
    async *readEvents(): AsyncGenerator<DialEvent, void, undefined> {
      for (;;) {
        while (events.length === 0) {
          await new Promise<void>((resolve) => {
            waiter.wake = resolve;
          });
        }

        const event = events.shift();

        if (event === null || event === undefined) {
          return;
        }

        yield event;
      }
    },
  };

  const stream: DialStream = {
    write: (data) => {
      state.written.push(decoder.decode(data));
    },
    drained: () => drain.gate.promise,
    end: () => {
      state.ended = true;
    },
    events: () => source.readEvents(),
    close: () => {
      state.closed = true;

      emit(null);
    },
  };

  return {
    stream,
    state,
    emit,

    // holds the guest's acks until `release`
    holdDrain: () => {
      drain.gate = Promise.withResolvers<void>();

      return drain.gate.resolve;
    },
  };
}

type FakeDial = ReturnType<typeof createFakeDial>;

function startTunnel(
  open: (target: DialTarget) => Promise<DialStream>,
  limits: TunnelLimits = createTunnelLimits(),
  impId = 'imp-1',
) {
  const sent: unknown[] = [];
  const binary: string[] = [];
  const closed: { code: number | null; reason: string } = { code: null, reason: '' };

  const session = createTunnelSession(
    {
      sendText: (text) => {
        sent.push(JSON.parse(text));
      },
      sendBinary: (data) => {
        binary.push(decoder.decode(data));
      },
      close: (code, reason) => {
        closed.code = code;
        closed.reason = reason;
      },
    },
    { findImpId: () => Promise.resolve(impId), openDial: (_name, target) => open(target) },
    limits,
  );

  return { session, sent, binary, closed };
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await Bun.sleep(1);
  }
}

async function openTunnel(): Promise<{ tunnel: ReturnType<typeof startTunnel>; dial: FakeDial }> {
  const dial = createFakeDial();
  const targets: DialTarget[] = [];

  const tunnel = startTunnel((target) => {
    targets.push(target);

    return Promise.resolve(dial.stream);
  });

  tunnel.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitUntil(() => tunnel.sent.length === 1);

  expect(targets).toEqual([{ network: 'tcp', address: '127.0.0.1:5432' }]);
  expect(tunnel.sent).toEqual([{ type: 'opened' }]);

  return { tunnel, dial };
}

test('a tunnel dials the port on the guest loopback and relays both ways with half-closes', async () => {
  const opened = await openTunnel();

  const tunnel = opened.tunnel;
  const dial = opened.dial;

  tunnel.session.handleMessage(encoder.encode('query'));
  tunnel.session.handleMessage({ type: 'eof' });

  await waitUntil(() => tunnel.sent.length === 2);

  expect(dial.state).toMatchObject({ written: ['query'], ended: true });
  expect(tunnel.sent[1]).toEqual({ type: 'ack', bytes: 5 });

  // the guest answers after the client's half-close, then ends its side
  dial.emit({ type: 'data', data: encoder.encode('rows') });
  dial.emit({ type: 'eof' });
  dial.emit(null);

  await waitUntil(() => tunnel.closed.code !== null);

  expect(tunnel.binary).toEqual(['rows']);
  expect(tunnel.sent[2]).toEqual({ type: 'eof' });
  expect(tunnel.closed.code).toBe(1000);
});

test('a relay that ends without both eofs closes as lost', async () => {
  const opened = await openTunnel();

  const tunnel = opened.tunnel;
  const dial = opened.dial;

  dial.emit(null);

  await waitUntil(() => tunnel.closed.code !== null);

  expect(tunnel.closed).toEqual({ code: TUNNEL_CLOSE_LOST, reason: 'lost' });
});

test('a failed dial and an old agent reach the client as coded errors', async () => {
  for (const code of ['DIAL_FAILED', 'AGENT_OUTDATED']) {
    const error = new AgentError(code, 'the detail');

    const tunnel = startTunnel(() => Promise.reject(error));

    tunnel.session.handleMessage({ type: 'open', name: 'box', port: 9 });

    await waitUntil(() => tunnel.closed.code !== null);

    expect(tunnel.sent).toEqual([{ type: 'error', code: error.code, message: error.detail }]);
  }
});

test('the guest output stops at the window until the client acks', async () => {
  const opened = await openTunnel();

  const tunnel = opened.tunnel;
  const dial = opened.dial;
  const chunk = 'x'.repeat(TUNNEL_WINDOW_BYTES);

  dial.emit({ type: 'data', data: encoder.encode(chunk) });
  dial.emit({ type: 'data', data: encoder.encode('y') });
  dial.emit({ type: 'data', data: encoder.encode('z') });

  await waitUntil(() => tunnel.binary.length === 2);

  await Bun.sleep(20);

  expect(tunnel.binary).toHaveLength(2);

  tunnel.session.handleMessage({ type: 'ack', bytes: TUNNEL_WINDOW_BYTES });

  await waitUntil(() => tunnel.binary.length === 3);
});

test('the client bytes are acked only once the guest connection took them', async () => {
  const opened = await openTunnel();

  const tunnel = opened.tunnel;
  const dial = opened.dial;
  const release = dial.holdDrain();

  tunnel.session.handleMessage(encoder.encode('abc'));
  tunnel.session.handleMessage(encoder.encode('de'));

  await Bun.sleep(20);

  expect(tunnel.sent).toEqual([{ type: 'opened' }]);

  release();

  await waitUntil(() => tunnel.sent.length > 1);

  const acked = tunnel.sent
    .slice(1)
    .map((message) => z.object({ bytes: z.number() }).parse(message).bytes)
    .reduce((total, bytes) => total + bytes, 0);

  expect(acked).toBe(5);
});

test('a client that ignores the window is closed before impd holds more than one frame past it', async () => {
  const opened = await openTunnel();

  const tunnel = opened.tunnel;
  const dial = opened.dial;

  dial.holdDrain();

  const frame = new Uint8Array(TUNNEL_MAX_FRAME_BYTES);

  const frames = (TUNNEL_WINDOW_BYTES + TUNNEL_MAX_FRAME_BYTES) / TUNNEL_MAX_FRAME_BYTES;

  for (let index = 0; index < frames; index++) {
    tunnel.session.handleMessage(frame);
  }

  expect(tunnel.closed.code).toBeNull();

  tunnel.session.handleMessage(new Uint8Array(1));

  expect(tunnel.closed).toEqual({ code: TUNNEL_CLOSE_PROTOCOL, reason: 'past the window' });
  expect(dial.state.written).toHaveLength(frames);
});

test('a binary message larger than a frame breaks the protocol', async () => {
  const opened = await openTunnel();

  opened.tunnel.session.handleMessage(new Uint8Array(TUNNEL_MAX_FRAME_BYTES + 1));

  expect(opened.tunnel.closed.code).toBe(TUNNEL_CLOSE_PROTOCOL);
  expect(opened.dial.state.written).toEqual([]);
});

test('the open tunnels of an imp stop at the limit, and a closed one frees its place', async () => {
  const limits = createTunnelLimits(1);
  const dial = createFakeDial();
  const first = startTunnel(() => Promise.resolve(dial.stream), limits);
  const second = startTunnel(() => Promise.resolve(createFakeDial().stream), limits);

  first.session.handleMessage({ type: 'open', name: 'box', port: 80 });
  second.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitUntil(() => second.closed.code !== null);

  expect(second.sent).toEqual([expect.objectContaining({ type: 'error', code: 'TUNNEL_LIMIT' })]);

  first.session.handleClose();

  const third = startTunnel(() => Promise.resolve(createFakeDial().stream), limits);

  third.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitUntil(() => third.sent.length === 1);

  expect(third.sent).toEqual([{ type: 'opened' }]);
});

test('the limit counts by imp id, so an imp recreated under the same name starts at zero', async () => {
  const limits = createTunnelLimits(1);
  const old = startTunnel(() => Promise.resolve(createFakeDial().stream), limits, 'old-id');
  const recreated = startTunnel(() => Promise.resolve(createFakeDial().stream), limits, 'new-id');

  old.session.handleMessage({ type: 'open', name: 'box', port: 80 });
  recreated.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitUntil(() => old.sent.length === 1 && recreated.sent.length === 1);

  expect([old.sent, recreated.sent]).toEqual([[{ type: 'opened' }], [{ type: 'opened' }]]);
});

test('a client that goes while the imp wakes gets its dial closed', async () => {
  const dial = createFakeDial();
  const pending = Promise.withResolvers<DialStream>();
  const dialing = { started: false };

  const tunnel = startTunnel(() => {
    dialing.started = true;

    return pending.promise;
  });

  tunnel.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitUntil(() => dialing.started);

  tunnel.session.handleClose();
  pending.resolve(dial.stream);

  await waitUntil(() => dial.state.closed);

  expect(tunnel.sent).toEqual([]);
});

test('data before opened, or a second open, breaks the protocol', async () => {
  const early = startTunnel(() => Promise.resolve(createFakeDial().stream));

  early.session.handleMessage(encoder.encode('too soon'));

  expect(early.closed.code).toBe(TUNNEL_CLOSE_PROTOCOL);

  const opened = await openTunnel();

  const tunnel = opened.tunnel;

  tunnel.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  expect(tunnel.closed.code).toBe(TUNNEL_CLOSE_PROTOCOL);
});
