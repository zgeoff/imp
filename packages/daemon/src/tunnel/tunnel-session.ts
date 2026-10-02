import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_NORMAL,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_WINDOW_BYTES,
  TunnelClientMessageSchema,
} from '@imp/api';
import type { TunnelClientMessage, TunnelServerMessage } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import type { DialStream, DialTarget } from '../agent-client/dial-stream';
import type { GuestListener, ListenSpec } from '../agent-client/listener-stream';
import { readErrorMessage } from '../read-error-message';
import type { ReverseForwards } from '../reverse/reverse-forwards';
import { runGuestListener } from '../reverse/run-guest-listener';

// at most this many tunnels per imp at a time; the next is refused with
// TUNNEL_LIMIT, so a client in a loop cannot pile up agent connections
const MAX_TUNNELS_PER_IMP = 256;

// a client that keeps no window: past this many unacked bytes, impd would
// hold whatever it sends
const MAX_PENDING_BYTES = TUNNEL_WINDOW_BYTES + TUNNEL_MAX_FRAME_BYTES;

// The two ends a tunnel bridges: the WebSocket peer and the imp service.
export interface TunnelPeer {
  readonly sendText: (text: string) => void;
  readonly sendBinary: (data: Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface TunnelBackend {
  // the imp's id, which the limit counts by, so a recreated imp starts at
  // zero; throws NOT_FOUND, and never wakes the imp
  readonly findImpId: (name: string) => Promise<string>;

  // a connection inside the imp, counted as a tunnel while open
  readonly openDial: (name: string, target: DialTarget) => Promise<DialStream>;

  // a reverse forward's listener, which alone keeps nothing awake, and the
  // relay for one of its clients, counted as a tunnel while open
  readonly openListener: (name: string, spec: ListenSpec) => Promise<GuestListener>;
  readonly openAccept: (name: string, listener: string, connection: number) => Promise<DialStream>;

  // who the socket's caller is: only it may accept its forward's clients
  readonly owner: string;
}

export interface TunnelSession {
  // a text message parsed as JSON, or a binary message as bytes
  readonly handleMessage: (message: unknown) => void;
  readonly handleClose: () => void;
}

type TunnelListen = Extract<TunnelClientMessage, { type: 'listen' }>;

// open tunnels per imp id, shared by every tunnel socket; each reverse
// forward relay counts as one
export interface TunnelLimits {
  // a release to call once, or null when the imp is at the limit
  readonly tryOpen: (impId: string) => (() => void) | null;
}

export function createTunnelLimits(max = MAX_TUNNELS_PER_IMP): TunnelLimits {
  const counts = new Map<string, number>();

  return {
    tryOpen: (impId) => {
      const count = counts.get(impId) ?? 0;

      if (count >= max) {
        return null;
      }

      counts.set(impId, count + 1);

      let released = false;

      return () => {
        if (released) {
          return;
        }

        released = true;

        const left = (counts.get(impId) ?? 1) - 1;

        if (left === 0) {
          counts.delete(impId);
        } else {
          counts.set(impId, left);
        }
      };
    },
  };
}

function buildErrorMessage(error: unknown): TunnelServerMessage {
  if (error instanceof ORPCError) {
    return { type: 'error', code: String(error.code), message: error.message };
  }

  if (error instanceof AgentError) {
    return { type: 'error', code: error.code, message: error.detail };
  }

  return { type: 'error', message: readErrorMessage(error) };
}

// One `imp proxy` connection: `open` dials 127.0.0.1:<port> in the imp through
// the agent, so a loopback-only server works; bytes then flow both ways under
// a window each way (packages/api tunnel-protocol).
export function createTunnelSession(
  peer: TunnelPeer,
  backend: TunnelBackend,
  limits: TunnelLimits,
  forwards: ReverseForwards,
): TunnelSession {
  const state: {
    phase: 'waiting' | 'opening' | 'open' | 'listening' | 'closed';
    stream: DialStream | null;
    listener: GuestListener | null;
    release: () => void;

    // bytes sent to the peer and not acked yet, and a wait for an ack
    unacked: number;
    ackWaiter: (() => void) | null;

    // bytes from the peer written to the guest and not acked yet
    pendingAck: number;
    acking: boolean;
    guestEof: boolean;
    peerEof: boolean;
  } = {
    phase: 'waiting',
    stream: null,
    listener: null,
    release: () => {},
    unacked: 0,
    ackWaiter: null,
    pendingAck: 0,
    acking: false,
    guestEof: false,
    peerEof: false,
  };

  const send = (message: TunnelServerMessage): void => {
    peer.sendText(JSON.stringify(message));
  };

  const stopTunnel = (code: number, reason: string): void => {
    if (state.phase === 'closed') {
      return;
    }

    state.phase = 'closed';
    state.stream?.close();
    state.listener?.close();
    state.release();
    state.ackWaiter?.();
    peer.close(code, reason);
  };

  const stopWithError = (error: unknown): void => {
    if (state.phase === 'closed') {
      return;
    }

    send(buildErrorMessage(error));
    stopTunnel(TUNNEL_CLOSE_NORMAL, 'tunnel failed');
  };

  const waitForWindow = async (): Promise<void> => {
    while (state.phase === 'open' && state.unacked > TUNNEL_WINDOW_BYTES) {
      await new Promise<void>((resolve) => {
        state.ackWaiter = resolve;
      });

      state.ackWaiter = null;
    }
  };

  // the guest's bytes to the peer, within the window
  const sendGuestOutput = async (stream: DialStream): Promise<void> => {
    for await (const event of stream.events()) {
      if (event.type === 'eof') {
        state.guestEof = true;

        send({ type: 'eof' });
        continue;
      }

      await waitForWindow();

      if (state.phase !== 'open') {
        return;
      }

      peer.sendBinary(event.data);

      state.unacked += event.data.byteLength;
    }

    // the agent ends a relay once both sides sent their eof; any other end
    // is a lost connection (a forced sleep, a reset)
    const complete = state.guestEof && state.peerEof;
    const code = complete ? TUNNEL_CLOSE_NORMAL : TUNNEL_CLOSE_LOST;
    const reason = complete ? 'done' : 'lost';

    stopTunnel(code, reason);
  };

  const runTunnel = async (stream: DialStream): Promise<void> => {
    try {
      await sendGuestOutput(stream);
    } catch {
      stopTunnel(TUNNEL_CLOSE_LOST, 'lost');
    }
  };

  // acks the peer's bytes once the guest connection has taken them
  const sendPeerAcks = async (stream: DialStream): Promise<void> => {
    state.acking = true;

    while (state.pendingAck > 0 && state.phase === 'open') {
      const bytes = state.pendingAck;

      await stream.drained();

      state.pendingAck -= bytes;

      if (state.phase === 'open') {
        send({ type: 'ack', bytes });
      }
    }

    state.acking = false;
  };

  // the imp's id, or null once the session failed or the peer left
  const findOpeningImp = async (name: string): Promise<string | null> => {
    state.phase = 'opening';

    try {
      const impId = await backend.findImpId(name);

      return state.phase === 'opening' ? impId : null;
    } catch (error) {
      stopWithError(error);

      return null;
    }
  };

  const buildLimitError = (name: string): ORPCError<'TUNNEL_LIMIT', unknown> =>
    new ORPCError('TUNNEL_LIMIT', {
      message: `${name} has ${String(MAX_TUNNELS_PER_IMP)} tunnels open already`,
    });

  // `reserve` counts the tunnel, or throws why it may not open
  const openTunnel = async (
    name: string,
    reserve: (impId: string) => () => void,
    open: () => Promise<DialStream>,
  ): Promise<void> => {
    const impId = await findOpeningImp(name);

    if (impId === null) {
      return;
    }

    let stream: DialStream;

    try {
      state.release = reserve(impId);

      stream = await open();
    } catch (error) {
      stopWithError(error);

      return;
    }

    // the peer went away while the imp woke
    if (state.phase !== 'opening') {
      stream.close();

      return;
    }

    state.stream = stream;
    state.phase = 'open';

    send({ type: 'opened' });
    void runTunnel(stream);
  };

  const allocateTunnel = (name: string, impId: string): (() => void) => {
    const release = limits.tryOpen(impId);

    if (release === null) {
      throw buildLimitError(name);
    }

    return release;
  };

  // an accept takes a client of the caller's own forward, within its relays
  const allocateRelay = (name: string, listener: string, impId: string): (() => void) => {
    const relay = forwards.tryAccept(listener, impId, backend.owner);

    if ('refused' in relay) {
      throw relay.refused === 'full'
        ? new ORPCError('TUNNEL_LIMIT', {
            message: `the reverse forward has its most relays open already`,
          })
        : new ORPCError('NOT_FOUND', {
            message: `no reverse forward ${listener} of yours on ${name}`,
          });
    }

    try {
      const release = allocateTunnel(name, impId);

      return () => {
        release();

        relay.release();
      };
    } catch (error) {
      relay.release();
      throw error;
    }
  };

  // a client of the forward that cannot be taken is closed at once
  const stopGuestClient = async (name: string, listener: string, id: number): Promise<void> => {
    try {
      const stream = await backend.openAccept(name, listener, id);

      stream.close();
    } catch {
      // the client is gone already, or the agent is
    }
  };

  // The forward lives until the peer closes the socket, or the guest
  // listener ends, as after a forced sleep: the client listens again.
  const runForward = async (name: string, listener: GuestListener): Promise<void> => {
    try {
      await runGuestListener(listener, {
        deliver: (id) => {
          send({ type: 'connection', id });

          return Promise.resolve();
        },
        refuse: (id) => stopGuestClient(name, listener.id, id),
        isFull: () => forwards.isFull(listener.id),
      });
    } catch {
      // the agent connection broke; the close below says so
    }

    stopTunnel(TUNNEL_CLOSE_LOST, 'lost');
  };

  const openForward = async (control: TunnelListen): Promise<void> => {
    const impId = await findOpeningImp(control.name);

    if (impId === null) {
      return;
    }

    const spec: ListenSpec =
      control.network === 'tcp'
        ? { network: 'tcp', port: control.port ?? 0 }
        : { network: 'unix', path: control.path ?? null };

    let listener: GuestListener;

    try {
      listener = await backend.openListener(control.name, spec);
    } catch (error) {
      stopWithError(error);

      return;
    }

    if (state.phase !== 'opening') {
      listener.close();

      return;
    }

    state.listener = listener;
    state.release = forwards.register(listener.id, impId, backend.owner);
    state.phase = 'listening';

    send({ type: 'listening', listener: listener.id, path: listener.path, port: listener.port });
    void runForward(control.name, listener);
  };

  const handleControl = (message: unknown): void => {
    const parsed = TunnelClientMessageSchema.safeParse(message);

    if (!parsed.success) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, 'bad message');

      return;
    }

    const control = parsed.data;

    if (control.type === 'open' || control.type === 'listen' || control.type === 'accept') {
      if (state.phase !== 'waiting') {
        stopTunnel(TUNNEL_CLOSE_PROTOCOL, `${control.type} after the start`);
      } else if (control.type === 'open') {
        const name = control.name;
        const target: DialTarget = { network: 'tcp', address: `127.0.0.1:${String(control.port)}` };

        void openTunnel(
          name,
          (impId) => allocateTunnel(name, impId),
          () => backend.openDial(name, target),
        );
      } else if (control.type === 'accept') {
        const name = control.name;

        void openTunnel(
          name,
          (impId) => allocateRelay(name, control.listener, impId),
          () => backend.openAccept(name, control.listener, control.connection),
        );
      } else {
        void openForward(control);
      }

      return;
    }

    const stream = state.stream;

    if (state.phase !== 'open' || stream === null) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, `${control.type} before opened`);

      return;
    }

    if (control.type === 'eof') {
      state.peerEof = true;

      stream.end();
    } else {
      state.unacked = Math.max(0, state.unacked - control.bytes);
      state.ackWaiter?.();
    }
  };

  const handleData = (data: Uint8Array): void => {
    const stream = state.stream;

    if (state.phase !== 'open' || stream === null || state.peerEof) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, 'data outside an open tunnel');

      return;
    }

    state.pendingAck += data.byteLength;

    if (data.byteLength > TUNNEL_MAX_FRAME_BYTES || state.pendingAck > MAX_PENDING_BYTES) {
      stopTunnel(TUNNEL_CLOSE_PROTOCOL, 'past the window');

      return;
    }

    stream.write(data);

    if (!state.acking) {
      void sendPeerAcks(stream);
    }
  };

  return {
    handleMessage: (message) => {
      if (state.phase === 'closed') {
        return;
      }

      if (message instanceof Uint8Array) {
        handleData(message);
      } else {
        handleControl(message);
      }
    },
    handleClose: () => {
      if (state.phase === 'closed') {
        return;
      }

      state.phase = 'closed';
      state.stream?.close();
      state.listener?.close();
      state.release();
      state.ackWaiter?.();
    },
  };
}
