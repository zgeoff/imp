import type { GuestListener } from '../agent-client/listener-stream';

// at most this many open relays per reverse forward (and per SSH connection
// for ssh-agent forwarding); a guest that opens more gets the extras closed,
// so it cannot flood the client
export const MAX_RELAYS_PER_FORWARD = 64;

export interface GuestListenerHandlers {
  // pairs a waiting client with the client's side; settles once its relay
  // ended, or at once when the relay runs elsewhere
  readonly deliver: (id: number) => Promise<void>;

  // accepts the client and closes it at once, so it sees the close
  readonly refuse: (id: number) => Promise<void>;

  // true while the forward has its most relays open
  readonly isFull: () => boolean;
}

// Hands each client of a guest listener on, until the listener ends: its
// agent connection closed, as after a forced sleep, or impd closed it.
// ssh-agent forwarding, `ssh -R` and reverse tunnels all run here.
export async function runGuestListener(
  listener: GuestListener,
  handlers: GuestListenerHandlers,
): Promise<void> {
  for await (const id of listener.connections()) {
    void (handlers.isFull() ? handlers.refuse(id) : handlers.deliver(id));
  }
}
