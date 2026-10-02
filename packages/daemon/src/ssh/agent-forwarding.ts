import type { Connection, ServerChannel } from 'ssh2';
import type { AgentListener } from '../agent-client/agent-forward-stream';
import { formatFailure, runChannelRelay } from './channel-io';
import type { SshBackend } from './ssh-connection-context';

// open agent channels to the client per SSH connection; a guest that opens
// more gets its extra clients closed, so it cannot flood the user's laptop
export const MAX_AGENT_CHANNELS = 16;

// ssh-agent forwarding for one SSH connection (`ssh -A`).
export interface AgentForwarding {
  // a session asked for forwarding (`auth-agent-req@openssh.com`)
  readonly enable: () => void;

  // the guest socket for SSH_AUTH_SOCK, made on first use, or null when no
  // session asked; throws when the imp cannot serve one
  readonly findSocket: () => Promise<string | null>;
  readonly stop: () => void;
}

interface AgentForwardingDeps {
  readonly client: Connection;
  readonly impName: string;
  readonly backend: Pick<SshBackend, 'requireRunning' | 'openAgentListener' | 'openAgentAccept'>;
  readonly log: (message: string) => void;
}

async function stopListenerWhenOpen(listening: Promise<AgentListener>): Promise<void> {
  try {
    const listener = await listening;

    listener.close();
  } catch {
    // it never opened
  }
}

// As with sshd, forwarding belongs to the connection: once a session asked,
// every later session gets SSH_AUTH_SOCK, from one listener in the guest.
// Each client of it becomes an `auth-agent@openssh.com` channel.
export function createAgentForwarding(deps: AgentForwardingDeps): AgentForwarding {
  const state: {
    listening: Promise<AgentListener> | null;

    // tells a stale listener from the current one
    generation: number;

    // the VM the listener lives in: a wake starts a new one
    pid: number | null;
    channels: number;
    enabled: boolean;
    stopped: boolean;
  } = {
    listening: null,
    generation: 0,
    pid: null,
    channels: 0,
    enabled: false,
    stopped: false,
  };

  const stopListener = (): void => {
    const listening = state.listening;

    state.listening = null;
    state.generation += 1;

    if (listening !== null) {
      void stopListenerWhenOpen(listening);
    }
  };

  const writeLog = (message: string): void => {
    deps.log(`impd: ssh: ${deps.impName}: agent forwarding: ${message}`);
  };

  // an accept that impd closes at once: the guest client sees the close
  const stopGuestClient = async (listener: AgentListener, id: number): Promise<void> => {
    try {
      const stream = await deps.backend.openAgentAccept(deps.impName, listener.id, id);

      stream.close();
    } catch {
      // the client is gone already, or the agent is; either way it is closed
    }
  };

  const openClientChannel = (): Promise<ServerChannel> =>
    new Promise((resolve, reject) => {
      deps.client.openssh_authAgent((failure, channel) => {
        if (failure === undefined) {
          resolve(channel);
        } else {
          reject(failure);
        }
      });
    });

  // A client that refuses the channel (it has no agent) gets the guest
  // client closed at once, so `ssh-add` fails fast.
  const sendToClientAgent = async (listener: AgentListener, id: number): Promise<void> => {
    let channel: ServerChannel;

    try {
      channel = await openClientChannel();
    } catch (error) {
      writeLog(`the client refused the agent channel: ${formatFailure(error)}`);

      await stopGuestClient(listener, id);

      return;
    }

    try {
      const relay = await deps.backend.openAgentAccept(deps.impName, listener.id, id);

      await runChannelRelay(channel, relay);
    } catch (error) {
      channel.destroy();

      writeLog(formatFailure(error));
    }
  };

  const handleConnection = async (listener: AgentListener, id: number): Promise<void> => {
    if (state.channels >= MAX_AGENT_CHANNELS) {
      await stopGuestClient(listener, id);

      return;
    }

    state.channels += 1;

    try {
      await sendToClientAgent(listener, id);
    } finally {
      state.channels -= 1;
    }
  };

  // A listener ends with its agent connection (a forced sleep resets it);
  // the next session then listens again.
  const runListener = async (listener: AgentListener, generation: number): Promise<void> => {
    try {
      for await (const id of listener.connections()) {
        void handleConnection(listener, id);
      }
    } catch (error) {
      writeLog(`the guest socket ended: ${formatFailure(error)}`);
    } finally {
      listener.close();

      if (state.generation === generation) {
        state.listening = null;
      }
    }
  };

  const openListener = async (generation: number): Promise<AgentListener> => {
    let listener: AgentListener;

    try {
      listener = await deps.backend.openAgentListener(deps.impName);
    } catch (error) {
      if (state.generation === generation) {
        state.listening = null;
      }

      throw error;
    }

    // the connection closed while the guest made the socket
    if (state.stopped) {
      listener.close();
      throw new Error('the SSH connection closed');
    }

    void runListener(listener, generation);

    return listener;
  };

  return {
    enable: () => {
      state.enabled = true;
    },
    findSocket: async () => {
      if (!state.enabled) {
        return null;
      }

      // A forced sleep resets the listener's agent connection, but impd may
      // see that only after the next session asks; a new VM settles it.
      const running = await deps.backend.requireRunning(deps.impName);

      if (state.listening !== null && state.pid !== running.imp.pid) {
        stopListener();
      }

      // sessions that start together share one listener
      if (state.listening === null) {
        state.generation += 1;
        state.pid = running.imp.pid;
        state.listening = openListener(state.generation);
      }

      const listener = await state.listening;

      return listener.path;
    },
    stop: () => {
      state.stopped = true;

      stopListener();
    },
  };
}
