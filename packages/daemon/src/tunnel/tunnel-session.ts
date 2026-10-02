import { TUNNEL_CLOSE_LOST, TUNNEL_WINDOW_BYTES, TunnelClientMessageSchema } from '@imp/api';
import type { TunnelServerMessage } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import type { DialStream, DialTarget } from '../agent-client/dial-stream';
import { readErrorMessage } from '../read-error-message';

// at most this many tunnels per imp at a time; the next is refused with
// TUNNEL_LIMIT, so a client in a loop cannot pile up agent connections
const MAX_TUNNELS_PER_IMP = 256;

// WebSocket close codes: a normal end, and a message that breaks the protocol
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1008;

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
}

export interface TunnelSession {
  // a text message parsed as JSON, or a binary message as bytes
  readonly handleMessage: (message: unknown) => void;
  readonly handleClose: () => void;
}

// open tunnels per imp id, shared by every tunnel socket
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
): TunnelSession {
  const state: {
    phase: 'waiting' | 'opening' | 'open' | 'closed';
    stream: DialStream | null;
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
    state.release();
    state.ackWaiter?.();
    peer.close(code, reason);
  };

  const stopWithError = (error: unknown): void => {
    if (state.phase === 'closed') {
      return;
    }

    send(buildErrorMessage(error));
    stopTunnel(CLOSE_NORMAL, 'tunnel failed');
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
    const code = complete ? CLOSE_NORMAL : TUNNEL_CLOSE_LOST;
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

  const openTunnel = async (name: string, port: number): Promise<void> => {
    state.phase = 'opening';

    let impId: string;

    try {
      impId = await backend.findImpId(name);
    } catch (error) {
      stopWithError(error);

      return;
    }

    // the peer went away during the lookup
    if (state.phase !== 'opening') {
      return;
    }

    const release = limits.tryOpen(impId);

    if (release === null) {
      stopWithError(
        new ORPCError('TUNNEL_LIMIT', {
          message: `${name} has ${String(MAX_TUNNELS_PER_IMP)} tunnels open already`,
        }),
      );

      return;
    }

    state.release = release;

    let stream: DialStream;

    try {
      stream = await backend.openDial(name, {
        network: 'tcp',
        address: `127.0.0.1:${String(port)}`,
      });
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

  const handleControl = (message: unknown): void => {
    const parsed = TunnelClientMessageSchema.safeParse(message);

    if (!parsed.success) {
      stopTunnel(CLOSE_PROTOCOL, 'bad message');

      return;
    }

    const control = parsed.data;

    if (control.type === 'open') {
      if (state.phase === 'waiting') {
        void openTunnel(control.name, control.port);
      } else {
        stopTunnel(CLOSE_PROTOCOL, 'open twice');
      }

      return;
    }

    const stream = state.stream;

    if (state.phase !== 'open' || stream === null) {
      stopTunnel(CLOSE_PROTOCOL, `${control.type} before opened`);

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
      stopTunnel(CLOSE_PROTOCOL, 'data outside an open tunnel');

      return;
    }

    stream.write(data);

    state.pendingAck += data.byteLength;

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
      state.release();
      state.ackWaiter?.();
    },
  };
}
