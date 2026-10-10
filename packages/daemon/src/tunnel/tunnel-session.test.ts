import { expect, mock, test } from 'bun:test';
import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_NORMAL,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_WINDOW_BYTES,
} from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import type { DialStream } from '../agent-client/dial-stream';
import type { GuestListener } from '../agent-client/listener-stream';
import { createReverseForwards } from '../reverse/reverse-forwards';
import type { ReverseForwards } from '../reverse/reverse-forwards';
import { buildStubDialStream } from '../test-utils/build-stub-dial-stream';
import { buildStubGuestListener } from '../test-utils/build-stub-guest-listener';
import { createTunnelLimits, createTunnelSession } from './tunnel-session';
import type { TunnelBackend, TunnelLimits } from './tunnel-session';

interface TunnelTestConfig {
  readonly backend: TunnelBackend;
  readonly limits: TunnelLimits;
  readonly forwards: ReverseForwards;
}

// one `/tunnel` socket over the backend, with its peer recorded: the text
// messages parsed, the binary ones decoded, and the close
function setupTest(config: TunnelTestConfig) {
  const sent: unknown[] = [];
  const binary: string[] = [];
  const closed: { code: number | null; reason: string } = { code: null, reason: '' };

  const session = createTunnelSession(
    {
      sendText: (text) => {
        sent.push(JSON.parse(text));
      },
      sendBinary: (data) => {
        binary.push(new TextDecoder().decode(data));
      },
      close: (code, reason) => {
        closed.code = code;
        closed.reason = reason;
      },
    },
    config.backend,
    config.limits,
    config.forwards,
  );

  return { session, sent, binary, closed };
}

test('it dials the port on the guest loopback for an open', async () => {
  const dial = buildStubDialStream();
  const openDial = mock(() => Promise.resolve(dial.stream));

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial,
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toStrictEqual([{ type: 'opened' }]);
  });

  expect(openDial).toHaveBeenCalledExactlyOnceWith('box', {
    network: 'tcp',
    address: '127.0.0.1:5432',
  });
});

test('it writes the client bytes to the guest and acks them', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  ctx.session.handleMessage(new TextEncoder().encode('query'));

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(2);
  });

  expect(dial.state.written).toStrictEqual(['query']);
  expect(ctx.sent[1]).toStrictEqual({ type: 'ack', bytes: 5 });
});

test("it half-closes the guest connection on the client's eof", async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  ctx.session.handleMessage({ type: 'eof' });

  expect(dial.state.isEnded).toBeTrue();
  expect(ctx.closed.code).toBeNull();
});

test('it relays the guest bytes and its eof to the client', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  dial.emit({ type: 'data', data: new TextEncoder().encode('rows') });
  dial.emit({ type: 'eof' });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(2);
  });

  expect(ctx.binary).toStrictEqual(['rows']);
  expect(ctx.sent[1]).toStrictEqual({ type: 'eof' });
});

test('it closes as done once both sides sent their eof and the relay ends', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  ctx.session.handleMessage({ type: 'eof' });
  dial.emit({ type: 'eof' });
  dial.end();

  await waitFor(() => {
    expect(ctx.closed).toStrictEqual({ code: TUNNEL_CLOSE_NORMAL, reason: 'done' });
  });
});

test('it closes as lost when the relay ends without both eofs', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  dial.emit({ type: 'eof' });
  dial.end();

  await waitFor(() => {
    expect(ctx.closed).toStrictEqual({ code: TUNNEL_CLOSE_LOST, reason: 'lost' });
  });
});

test('it closes as lost when the agent connection breaks mid-relay', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  dial.fail(new Error('connection reset'));

  await waitFor(() => {
    expect(ctx.closed).toStrictEqual({ code: TUNNEL_CLOSE_LOST, reason: 'lost' });
  });

  expect(dial.state.isClosed).toBeTrue();
});

test.each(['DIAL_FAILED', 'AGENT_OUTDATED'])(
  'it sends the client a %s agent error with its detail',
  async (code) => {
    const ctx = setupTest({
      backend: {
        findImpId: () => Promise.resolve('imp-1'),
        openDial: () => Promise.reject(new AgentError(code, 'the detail')),
        openListener: mock(),
        openAccept: mock(),
        owner: 'token:me:1',
      },
      limits: createTunnelLimits(),
      forwards: createReverseForwards(),
    });

    ctx.session.handleMessage({ type: 'open', name: 'box', port: 9 });

    await waitFor(() => {
      expect(ctx.closed.code).not.toBeNull();
    });

    expect(ctx.sent).toStrictEqual([{ type: 'error', code, message: 'the detail' }]);
  },
);

test('it closes the socket normally after a failed open', async () => {
  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.reject(new AgentError('DIAL_FAILED', 'the detail')),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 9 });

  await waitFor(() => {
    expect(ctx.closed).toStrictEqual({ code: TUNNEL_CLOSE_NORMAL, reason: 'tunnel failed' });
  });
});

test('it sends the client an uncoded error for a failure that carries no code', async () => {
  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.reject(new Error('socket gone')),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 9 });

  await waitFor(() => {
    expect(ctx.closed.code).not.toBeNull();
  });

  expect(ctx.sent).toStrictEqual([{ type: 'error', message: 'socket gone' }]);
});

test('it sends the client NOT_FOUND for an imp that does not exist', async () => {
  const openDial = mock();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.reject(new ORPCError('NOT_FOUND', { message: 'no imp named box' })),
      openDial,
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(ctx.closed.code).not.toBeNull();
  });

  expect(ctx.sent).toStrictEqual([
    { type: 'error', code: 'NOT_FOUND', message: 'no imp named box' },
  ]);

  expect(openDial).not.toHaveBeenCalled();
});

test('it holds the guest output past the window while the client has not acked', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  dial.emit({ type: 'data', data: new TextEncoder().encode('x'.repeat(TUNNEL_WINDOW_BYTES)) });
  dial.emit({ type: 'data', data: new TextEncoder().encode('y') });
  dial.emit({ type: 'data', data: new TextEncoder().encode('z') });

  // the tunnel has taken all three, so only the window holds the last
  await waitFor(() => {
    expect(dial.countUnread()).toBe(0);
  });

  expect(ctx.binary).toHaveLength(2);
});

test('it sends the held guest output once the client acks', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  dial.emit({ type: 'data', data: new TextEncoder().encode('x'.repeat(TUNNEL_WINDOW_BYTES)) });
  dial.emit({ type: 'data', data: new TextEncoder().encode('y') });
  dial.emit({ type: 'data', data: new TextEncoder().encode('z') });

  await waitFor(() => {
    expect(dial.countUnread()).toBe(0);
  });

  ctx.session.handleMessage({ type: 'ack', bytes: TUNNEL_WINDOW_BYTES });

  await waitFor(() => {
    expect(ctx.binary).toHaveLength(3);
  });

  expect(ctx.binary[2]).toBe('z');
});

test('it holds the ack of the client bytes until the guest has taken them', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  const release = dial.holdDrain();

  ctx.session.handleMessage(new TextEncoder().encode('abc'));
  ctx.session.handleMessage(new TextEncoder().encode('de'));

  // guest bytes reach the client over later turns of the event loop, by
  // which time an unheld ack would have gone out
  dial.emit({ type: 'data', data: new TextEncoder().encode('reply') });

  const received = await waitFor(() => {
    invariant(ctx.binary[0], 'the guest bytes have not reached the client');

    return [...ctx.binary];
  });

  const sentWhileHeld = [...ctx.sent];
  const drainWaitsWhileHeld = dial.state.drainWaits;

  release();

  const sent = await waitFor(() => {
    invariant(ctx.sent[2], 'the second ack has not arrived');

    return [...ctx.sent];
  });

  expect(received).toStrictEqual(['reply']);
  expect(sentWhileHeld).toStrictEqual([{ type: 'opened' }]);
  expect(drainWaitsWhileHeld).toBe(1);

  expect(sent).toStrictEqual([
    { type: 'opened' },
    { type: 'ack', bytes: 3 },
    { type: 'ack', bytes: 2 },
  ]);
});

test('it keeps a client that sends up to one frame past the window unacked', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  dial.holdDrain();

  const frames = (TUNNEL_WINDOW_BYTES + TUNNEL_MAX_FRAME_BYTES) / TUNNEL_MAX_FRAME_BYTES;

  for (let index = 0; index < frames; index++) {
    ctx.session.handleMessage(new Uint8Array(TUNNEL_MAX_FRAME_BYTES));
  }

  expect(ctx.closed.code).toBeNull();
  expect(dial.state.written).toHaveLength(frames);
});

test('it closes a client that ignores the window past one frame over it', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  dial.holdDrain();

  const frames = (TUNNEL_WINDOW_BYTES + TUNNEL_MAX_FRAME_BYTES) / TUNNEL_MAX_FRAME_BYTES;

  for (let index = 0; index < frames; index++) {
    ctx.session.handleMessage(new Uint8Array(TUNNEL_MAX_FRAME_BYTES));
  }

  ctx.session.handleMessage(new Uint8Array(1));

  expect(ctx.closed).toStrictEqual({ code: TUNNEL_CLOSE_PROTOCOL, reason: 'past the window' });
  expect(dial.state.written).toHaveLength(frames);
});

test('it closes a client that sends a binary message larger than a frame', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 5432 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  ctx.session.handleMessage(new Uint8Array(TUNNEL_MAX_FRAME_BYTES + 1));

  expect(ctx.closed).toStrictEqual({ code: TUNNEL_CLOSE_PROTOCOL, reason: 'past the window' });
  expect(dial.state.written).toStrictEqual([]);
});

test('it names the imp limit it was given in the TUNNEL_LIMIT message', async () => {
  const limits = createTunnelLimits(2);

  const first = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  const second = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  const third = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  first.session.handleMessage({ type: 'open', name: 'box', port: 80 });
  second.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });

  third.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(third.closed.code).not.toBeNull();
  });

  expect(third.sent).toStrictEqual([
    { type: 'error', code: 'TUNNEL_LIMIT', message: 'box has 2 tunnels open already' },
  ]);
});

test('it refuses the 257th tunnel to an imp under the default limit', async () => {
  const limits = createTunnelLimits();

  const open = Array.from({ length: 256 }, () =>
    setupTest({
      backend: {
        findImpId: () => Promise.resolve('imp-1'),
        openDial: () => Promise.resolve(buildStubDialStream().stream),
        openListener: mock(),
        openAccept: mock(),
        owner: 'token:me:1',
      },
      limits,
      forwards: createReverseForwards(),
    }),
  );

  const last = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  for (const tunnel of open) {
    tunnel.session.handleMessage({ type: 'open', name: 'box', port: 80 });
  }

  await waitFor(() => {
    // false stands for not yet, as invariant throws on undefined
    invariant(
      open.every((tunnel) => tunnel.sent.length === 1) || undefined,
      'the 256 tunnels have not all opened',
    );
  });

  last.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    invariant(last.closed.code, 'the 257th tunnel is still open');
  });

  expect(open.map((tunnel) => tunnel.sent)).toSatisfyAll(
    (sent: readonly unknown[]) => sent.length === 1 && Bun.deepEquals(sent[0], { type: 'opened' }),
  );

  expect(last.sent).toStrictEqual([
    { type: 'error', code: 'TUNNEL_LIMIT', message: 'box has 256 tunnels open already' },
  ]);
});

test('it refuses a tunnel past the limit of its imp with TUNNEL_LIMIT', async () => {
  const limits = createTunnelLimits(1);

  const first = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  const second = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  first.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(first.sent).toHaveLength(1);
  });

  second.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(second.closed.code).not.toBeNull();
  });

  expect(second.sent).toStrictEqual([
    { type: 'error', code: 'TUNNEL_LIMIT', message: 'box has 1 tunnel open already' },
  ]);
});

test('it frees the place of a tunnel once its socket closes', async () => {
  const limits = createTunnelLimits(1);

  const first = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  const second = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  first.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(first.sent).toHaveLength(1);
  });

  first.session.handleClose();
  second.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(second.sent).toStrictEqual([{ type: 'opened' }]);
  });
});

test('it counts the limit by imp id, so an imp recreated under the same name starts at zero', async () => {
  const limits = createTunnelLimits(1);

  const old = setupTest({
    backend: {
      findImpId: () => Promise.resolve('old-id'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  const recreated = setupTest({
    backend: {
      findImpId: () => Promise.resolve('new-id'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  old.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(old.sent).toHaveLength(1);
  });

  recreated.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(recreated.sent).toStrictEqual([{ type: 'opened' }]);
  });
});

test('it closes the dial of a client that goes while the imp wakes', async () => {
  const dial = buildStubDialStream();
  const pending = Promise.withResolvers<DialStream>();
  const openDial = mock(() => pending.promise);

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial,
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(openDial).toHaveBeenCalledOnce();
  });

  ctx.session.handleClose();
  pending.resolve(dial.stream);

  await waitFor(() => {
    expect(dial.state.isClosed).toBeTrue();
  });

  expect(ctx.sent).toStrictEqual([]);
});

test('it closes a client that sends data before the tunnel opened', () => {
  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage(new TextEncoder().encode('too soon'));

  expect(ctx.closed).toStrictEqual({
    code: TUNNEL_CLOSE_PROTOCOL,
    reason: 'data outside an open tunnel',
  });
});

test.each([
  ['eof', { type: 'eof' }],
  ['ack', { type: 'ack', bytes: 5 }],
])('it closes a client that sends an %s before the tunnel opened', (type, message) => {
  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage(message);

  expect(ctx.closed).toStrictEqual({
    code: TUNNEL_CLOSE_PROTOCOL,
    reason: `${type} before opened`,
  });
});

test('it closes a client that sends a second open', async () => {
  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(buildStubDialStream().stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  expect(ctx.closed).toStrictEqual({ code: TUNNEL_CLOSE_PROTOCOL, reason: 'open after the start' });
});

test('it closes a client that sends data after its own eof', async () => {
  const dial = buildStubDialStream();

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: () => Promise.resolve(dial.stream),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 80 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  ctx.session.handleMessage({ type: 'eof' });
  ctx.session.handleMessage(new TextEncoder().encode('late'));

  expect(ctx.closed).toStrictEqual({
    code: TUNNEL_CLOSE_PROTOCOL,
    reason: 'data outside an open tunnel',
  });

  expect(dial.state.written).toStrictEqual([]);
});

test('it closes a client that sends a control message the protocol rejects', () => {
  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: mock(),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'open', name: 'box', port: 0 });

  expect(ctx.closed).toStrictEqual({ code: TUNNEL_CLOSE_PROTOCOL, reason: 'bad message' });
});

test('it answers a listen with where the guest listens', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });
  const openListener = mock(() => Promise.resolve(guest.listener));

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener,
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(ctx.sent).toStrictEqual([
      { type: 'listening', listener: 'fwd1', path: '/tmp/app.sock', port: null },
    ]);
  });

  expect(openListener).toHaveBeenCalledExactlyOnceWith('box', {
    network: 'unix',
    path: '/tmp/app.sock',
  });
});

test('it asks the guest for a socket of its choosing for a unix listen with no path', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: null });
  const openListener = mock(() => Promise.resolve(guest.listener));

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener,
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'listen', name: 'box', network: 'unix' });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  expect(openListener).toHaveBeenCalledExactlyOnceWith('box', { network: 'unix', path: null });

  expect(ctx.sent[0]).toStrictEqual({
    type: 'listening',
    listener: 'fwd1',
    path: '/run/imp/forward/fwd1/sock',
    port: null,
  });
});

test('it listens on the guest port a tcp listen names', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'tcp', port: 8080 });
  const openListener = mock(() => Promise.resolve(guest.listener));

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener,
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'listen', name: 'box', network: 'tcp', port: 8080 });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  expect(openListener).toHaveBeenCalledExactlyOnceWith('box', { network: 'tcp', port: 8080 });

  expect(ctx.sent[0]).toStrictEqual({
    type: 'listening',
    listener: 'fwd1',
    path: null,
    port: 8080,
  });
});

test('it names each guest client of a forward to the client', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () => Promise.resolve(guest.listener),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  guest.connect(1);
  guest.connect(2);

  await waitFor(() => {
    expect(ctx.sent.slice(1)).toStrictEqual([
      { type: 'connection', id: 1 },
      { type: 'connection', id: 2 },
    ]);
  });
});

test('it reports a listener the agent cannot open', async () => {
  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () => Promise.reject(new AgentError('LISTEN_FAILED', 'address in use')),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'listen', name: 'box', network: 'tcp', port: 8080 });

  await waitFor(() => {
    expect(ctx.closed.code).not.toBeNull();
  });

  expect(ctx.sent).toStrictEqual([
    { type: 'error', code: 'LISTEN_FAILED', message: 'address in use' },
  ]);
});

test('it closes a listener that opens after the client went', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: null });
  const pending = Promise.withResolvers<GuestListener>();
  const openListener = mock(() => pending.promise);

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener,
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({ type: 'listen', name: 'box', network: 'unix' });

  await waitFor(() => {
    expect(openListener).toHaveBeenCalledOnce();
  });

  ctx.session.handleClose();
  pending.resolve(guest.listener);

  await waitFor(() => {
    expect(guest.state.isClosed).toBeTrue();
  });

  expect(ctx.sent).toStrictEqual([]);
});

test('it opens a relay for an accept from the caller that listened', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });
  const accepted = buildStubDialStream();
  const openAccept = mock(() => Promise.resolve(accepted.stream));

  const backend: TunnelBackend = {
    findImpId: () => Promise.resolve('imp-1'),
    openDial: mock(),
    openListener: () => Promise.resolve(guest.listener),
    openAccept,
    owner: 'token:me:1',
  };

  const forwards = createReverseForwards();
  const control = setupTest({ backend, limits: createTunnelLimits(), forwards });
  const relay = setupTest({ backend, limits: createTunnelLimits(), forwards });

  control.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(control.sent).toHaveLength(1);
  });

  guest.connect(1);
  relay.session.handleMessage({ type: 'accept', name: 'box', listener: 'fwd1', connection: 1 });

  await waitFor(() => {
    expect(relay.sent).toStrictEqual([{ type: 'opened' }]);
  });

  expect(openAccept).toHaveBeenCalledExactlyOnceWith('box', 'fwd1', 1);
});

test('it relays both ways through an accepted client, as through an open', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });
  const accepted = buildStubDialStream();

  const backend: TunnelBackend = {
    findImpId: () => Promise.resolve('imp-1'),
    openDial: mock(),
    openListener: () => Promise.resolve(guest.listener),
    openAccept: () => Promise.resolve(accepted.stream),
    owner: 'token:me:1',
  };

  const forwards = createReverseForwards();
  const control = setupTest({ backend, limits: createTunnelLimits(), forwards });
  const relay = setupTest({ backend, limits: createTunnelLimits(), forwards });

  control.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(control.sent).toHaveLength(1);
  });

  relay.session.handleMessage({ type: 'accept', name: 'box', listener: 'fwd1', connection: 1 });

  await waitFor(() => {
    expect(relay.sent).toHaveLength(1);
  });

  relay.session.handleMessage(new TextEncoder().encode('hello'));
  accepted.emit({ type: 'data', data: new TextEncoder().encode('back') });

  await waitFor(() => {
    expect(relay.binary).toStrictEqual(['back']);
  });

  expect(accepted.state.written).toStrictEqual(['hello']);
});

test('it refuses an accept from another caller with NOT_FOUND', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });
  const openAccept = mock();
  const forwards = createReverseForwards();

  const control = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () => Promise.resolve(guest.listener),
      openAccept,
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards,
  });

  const other = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: mock(),
      openAccept,
      owner: 'token:someone-else:2',
    },
    limits: createTunnelLimits(),
    forwards,
  });

  control.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(control.sent).toHaveLength(1);
  });

  other.session.handleMessage({ type: 'accept', name: 'box', listener: 'fwd1', connection: 1 });

  await waitFor(() => {
    expect(other.closed.code).not.toBeNull();
  });

  expect(other.sent).toStrictEqual([
    { type: 'error', code: 'NOT_FOUND', message: 'no reverse forward fwd1 of yours on box' },
  ]);

  expect(openAccept).not.toHaveBeenCalled();
});

test('it refuses an accept for another imp with NOT_FOUND', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });
  const openAccept = mock();
  const forwards = createReverseForwards();

  const control = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () => Promise.resolve(guest.listener),
      openAccept,
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards,
  });

  const otherImp = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-2'),
      openDial: mock(),
      openListener: mock(),
      openAccept,
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards,
  });

  control.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(control.sent).toHaveLength(1);
  });

  otherImp.session.handleMessage({
    type: 'accept',
    name: 'other',
    listener: 'fwd1',
    connection: 1,
  });

  await waitFor(() => {
    expect(otherImp.closed.code).not.toBeNull();
  });

  expect(otherImp.sent).toStrictEqual([
    { type: 'error', code: 'NOT_FOUND', message: 'no reverse forward fwd1 of yours on other' },
  ]);

  expect(openAccept).not.toHaveBeenCalled();
});

test('it refuses an accept past the most relays of a forward with TUNNEL_LIMIT', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });

  const backend: TunnelBackend = {
    findImpId: () => Promise.resolve('imp-1'),
    openDial: mock(),
    openListener: () => Promise.resolve(guest.listener),
    openAccept: () => Promise.resolve(buildStubDialStream().stream),
    owner: 'token:me:1',
  };

  const forwards = createReverseForwards(1);
  const control = setupTest({ backend, limits: createTunnelLimits(), forwards });
  const first = setupTest({ backend, limits: createTunnelLimits(), forwards });
  const second = setupTest({ backend, limits: createTunnelLimits(), forwards });

  control.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(control.sent).toHaveLength(1);
  });

  first.session.handleMessage({ type: 'accept', name: 'box', listener: 'fwd1', connection: 1 });

  await waitFor(() => {
    expect(first.sent).toHaveLength(1);
  });

  second.session.handleMessage({ type: 'accept', name: 'box', listener: 'fwd1', connection: 2 });

  await waitFor(() => {
    expect(second.closed.code).not.toBeNull();
  });

  expect(second.sent).toStrictEqual([
    {
      type: 'error',
      code: 'TUNNEL_LIMIT',
      message: 'the reverse forward has its most relays open already',
    },
  ]);
});

test('it closes a guest client at once while the forward has its most relays open', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });
  const relayed = buildStubDialStream();
  const refused = buildStubDialStream();

  const openAccept = mock<TunnelBackend['openAccept']>()
    .mockResolvedValueOnce(relayed.stream)
    .mockResolvedValueOnce(refused.stream);

  const backend: TunnelBackend = {
    findImpId: () => Promise.resolve('imp-1'),
    openDial: mock(),
    openListener: () => Promise.resolve(guest.listener),
    openAccept,
    owner: 'token:me:1',
  };

  const forwards = createReverseForwards(1);
  const control = setupTest({ backend, limits: createTunnelLimits(), forwards });
  const relay = setupTest({ backend, limits: createTunnelLimits(), forwards });

  control.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(control.sent).toHaveLength(1);
  });

  relay.session.handleMessage({ type: 'accept', name: 'box', listener: 'fwd1', connection: 1 });

  await waitFor(() => {
    expect(relay.sent).toHaveLength(1);
  });

  guest.connect(2);

  await waitFor(() => {
    expect(refused.state.isClosed).toBeTrue();
  });

  expect(openAccept).toHaveBeenLastCalledWith('box', 'fwd1', 2);
  expect(control.sent).toHaveLength(1);
});

test('it keeps the forward listening when a refused guest client is gone already', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });

  const openAccept = mock<TunnelBackend['openAccept']>()
    .mockResolvedValueOnce(buildStubDialStream().stream)
    .mockRejectedValue(new AgentError('ACCEPT_FAILED', 'the client left'));

  const backend: TunnelBackend = {
    findImpId: () => Promise.resolve('imp-1'),
    openDial: mock(),
    openListener: () => Promise.resolve(guest.listener),
    openAccept,
    owner: 'token:me:1',
  };

  const forwards = createReverseForwards(1);
  const control = setupTest({ backend, limits: createTunnelLimits(), forwards });
  const relay = setupTest({ backend, limits: createTunnelLimits(), forwards });

  control.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(control.sent).toHaveLength(1);
  });

  relay.session.handleMessage({ type: 'accept', name: 'box', listener: 'fwd1', connection: 1 });

  await waitFor(() => {
    expect(relay.sent).toHaveLength(1);
  });

  guest.connect(2);
  guest.connect(3);

  await waitFor(() => {
    expect(openAccept).toHaveBeenCalledTimes(3);
  });

  expect(control.closed.code).toBeNull();
});

test('it counts every relay against the tunnel limit of its imp', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });

  const backend: TunnelBackend = {
    findImpId: () => Promise.resolve('imp-1'),
    openDial: mock(),
    openListener: () => Promise.resolve(guest.listener),
    openAccept: () => Promise.resolve(buildStubDialStream().stream),
    owner: 'token:me:1',
  };

  const forwards = createReverseForwards();
  const limits = createTunnelLimits(1);
  const control = setupTest({ backend, limits: createTunnelLimits(), forwards });
  const first = setupTest({ backend, limits, forwards });
  const second = setupTest({ backend, limits, forwards });

  control.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(control.sent).toHaveLength(1);
  });

  first.session.handleMessage({ type: 'accept', name: 'box', listener: 'fwd1', connection: 1 });

  await waitFor(() => {
    expect(first.sent).toHaveLength(1);
  });

  second.session.handleMessage({ type: 'accept', name: 'box', listener: 'fwd1', connection: 2 });

  await waitFor(() => {
    expect(second.closed.code).not.toBeNull();
  });

  expect(second.sent).toStrictEqual([
    { type: 'error', code: 'TUNNEL_LIMIT', message: 'box has 1 tunnel open already' },
  ]);
});

test('it refuses a listen past the tunnel limit of its imp, since a listener holds a tunnel', async () => {
  const limits = createTunnelLimits(1);

  const first = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () =>
        Promise.resolve(buildStubGuestListener('fwd1', { network: 'unix', path: null }).listener),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  const second = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () =>
        Promise.resolve(buildStubGuestListener('fwd2', { network: 'unix', path: null }).listener),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  first.session.handleMessage({ type: 'listen', name: 'box', network: 'unix' });

  await waitFor(() => {
    expect(first.sent).toHaveLength(1);
  });

  second.session.handleMessage({ type: 'listen', name: 'box', network: 'unix' });

  await waitFor(() => {
    expect(second.closed.code).not.toBeNull();
  });

  expect(second.sent).toStrictEqual([
    { type: 'error', code: 'TUNNEL_LIMIT', message: 'box has 1 tunnel open already' },
  ]);
});

test('it frees the tunnel of a listener once its socket closes', async () => {
  const limits = createTunnelLimits(1);

  const first = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () =>
        Promise.resolve(buildStubGuestListener('fwd1', { network: 'unix', path: null }).listener),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  const second = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () =>
        Promise.resolve(buildStubGuestListener('fwd2', { network: 'unix', path: null }).listener),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits,
    forwards: createReverseForwards(),
  });

  first.session.handleMessage({ type: 'listen', name: 'box', network: 'unix' });

  await waitFor(() => {
    expect(first.sent).toHaveLength(1);
  });

  first.session.handleClose();
  second.session.handleMessage({ type: 'listen', name: 'box', network: 'unix' });

  await waitFor(() => {
    expect(second.sent).toStrictEqual([
      { type: 'listening', listener: 'fwd2', path: '/run/imp/forward/fwd2/sock', port: null },
    ]);
  });
});

test('it ends the forward as lost when its guest listener ends', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () => Promise.resolve(guest.listener),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  guest.end();

  await waitFor(() => {
    expect(ctx.closed).toStrictEqual({ code: TUNNEL_CLOSE_LOST, reason: 'lost' });
  });
});

test('it closes the guest listener when the client closes the socket', async () => {
  const guest = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });

  const ctx = setupTest({
    backend: {
      findImpId: () => Promise.resolve('imp-1'),
      openDial: mock(),
      openListener: () => Promise.resolve(guest.listener),
      openAccept: mock(),
      owner: 'token:me:1',
    },
    limits: createTunnelLimits(),
    forwards: createReverseForwards(),
  });

  ctx.session.handleMessage({
    type: 'listen',
    name: 'box',
    network: 'unix',
    path: '/tmp/app.sock',
  });

  await waitFor(() => {
    expect(ctx.sent).toHaveLength(1);
  });

  ctx.session.handleClose();

  expect(guest.state.isClosed).toBeTrue();
});
